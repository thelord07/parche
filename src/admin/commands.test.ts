import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashToken } from '../auth/tokens.js';
import { devices, invites, members } from '../db/schema.js';
import { cleanupDir, makeApp, makeTempDataDir } from '../test-helpers.js';
import {
  createDevice,
  createGroup,
  createInvite,
  listMembers,
  revokeDevice,
  revokeInvite,
} from './commands.js';

describe('admin commands', () => {
  let dataDir: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    dataDir = await makeTempDataDir();
    app = await makeApp(dataDir);
  });

  afterEach(async () => {
    await app.close();
    await cleanupDir(dataDir);
  });

  // --------------------------------------------------------------------------
  // create-group
  // --------------------------------------------------------------------------
  describe('createGroup', () => {
    it('creates group, owner user, member and device; returns pch_ token', () => {
      const result = createGroup(app.db, {
        name: 'Test Group',
        slug: 'test-group',
        ownerName: 'Alice',
        ownerEmail: 'alice@example.com',
      });

      expect(result.deviceToken).toMatch(/^pch_/);
      expect(result.groupId).toBeTruthy();
      expect(result.userId).toBeTruthy();
      expect(result.deviceId).toBeTruthy();
    });

    it('stores token_hash (sha256 hex), not the plain token', () => {
      const result = createGroup(app.db, {
        name: 'Hash Check Group',
        slug: 'hash-check',
        ownerName: 'Bob',
        ownerEmail: 'bob@example.com',
      });

      const device = app.db.select().from(devices).where(eq(devices.id, result.deviceId)).get();

      expect(device).toBeDefined();
      expect(device?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      // Must be the hash, not the plain token
      expect(device?.tokenHash).toBe(hashToken(result.deviceToken));
      expect(device?.tokenHash).not.toContain('pch_');
    });

    it('uses deviceLabel "owner" by default', () => {
      const result = createGroup(app.db, {
        name: 'Label Group',
        slug: 'label-group',
        ownerName: 'Carol',
        ownerEmail: 'carol@example.com',
      });
      const device = app.db.select().from(devices).where(eq(devices.id, result.deviceId)).get();
      expect(device?.label).toBe('owner');
    });

    it('accepts a custom deviceLabel', () => {
      const result = createGroup(app.db, {
        name: 'Custom Label',
        slug: 'custom-label',
        ownerName: 'Dave',
        ownerEmail: 'dave@example.com',
        deviceLabel: 'my-laptop',
      });
      const device = app.db.select().from(devices).where(eq(devices.id, result.deviceId)).get();
      expect(device?.label).toBe('my-laptop');
    });

    it('reuses an existing user by email', () => {
      const r1 = createGroup(app.db, {
        name: 'Group A',
        slug: 'group-a',
        ownerName: 'Eve',
        ownerEmail: 'eve@example.com',
      });
      // Create another group with the same owner email — should reuse the user
      const r2 = createGroup(app.db, {
        name: 'Group B',
        slug: 'group-b',
        ownerName: 'Eve (updated name ignored)',
        ownerEmail: 'eve@example.com',
      });
      expect(r1.userId).toBe(r2.userId);
    });

    it('throws on duplicate slug', () => {
      createGroup(app.db, {
        name: 'Dup Group',
        slug: 'dup',
        ownerName: 'Frank',
        ownerEmail: 'frank@example.com',
      });
      expect(() =>
        createGroup(app.db, {
          name: 'Dup Group 2',
          slug: 'dup',
          ownerName: 'Frank2',
          ownerEmail: 'frank2@example.com',
        }),
      ).toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // create-invite
  // --------------------------------------------------------------------------
  describe('createInvite', () => {
    it('returns a XXXX-XXXX code and stores only the hash', () => {
      createGroup(app.db, {
        name: 'Invite Group',
        slug: 'invite-group',
        ownerName: 'Grace',
        ownerEmail: 'grace@example.com',
      });

      const result = createInvite(app.db, {
        group: 'invite-group',
        role: 'editor',
        expires: 'never',
        maxUses: 1,
      });

      expect(result.inviteCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

      const invite = app.db.select().from(invites).where(eq(invites.id, result.inviteId)).get();

      expect(invite).toBeDefined();
      expect(invite?.codeHash).toMatch(/^[0-9a-f]{64}$/);
      // Must be the hash, not the plain code
      expect(invite?.codeHash).not.toBe(result.inviteCode);
      expect(invite?.uses).toBe(0);
      expect(invite?.maxUses).toBe(1);
      expect(invite?.revokedAt).toBeNull();
    });

    it('throws for unknown group', () => {
      expect(() => createInvite(app.db, { group: 'nonexistent', role: 'editor' })).toThrow();
    });

    it('throws for invalid role', () => {
      createGroup(app.db, {
        name: 'Role Group',
        slug: 'role-group',
        ownerName: 'Hank',
        ownerEmail: 'hank@example.com',
      });
      expect(() =>
        createInvite(app.db, {
          group: 'role-group',
          // @ts-expect-error — testing runtime guard
          role: 'owner',
        }),
      ).toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // list-members
  // --------------------------------------------------------------------------
  describe('listMembers', () => {
    it('returns active members with name, email, role', () => {
      createGroup(app.db, {
        name: 'List Group',
        slug: 'list-group',
        ownerName: 'Iris',
        ownerEmail: 'iris@example.com',
      });

      const rows = listMembers(app.db, { group: 'list-group' });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.email).toBe('iris@example.com');
      expect(rows[0]?.role).toBe('owner');
    });

    it('throws for unknown group', () => {
      expect(() => listMembers(app.db, { group: 'no-such' })).toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // revoke-device
  // --------------------------------------------------------------------------
  describe('revokeDevice', () => {
    it('sets revoked_at and does NOT delete the row', () => {
      const { deviceId } = createGroup(app.db, {
        name: 'Revoke Group',
        slug: 'revoke-group',
        ownerName: 'Jack',
        ownerEmail: 'jack@example.com',
      });

      const countBefore = app.db.select().from(devices).all().length;

      revokeDevice(app.db, { deviceId });

      const countAfter = app.db.select().from(devices).all().length;
      expect(countAfter).toBe(countBefore); // no deletion

      const device = app.db.select().from(devices).where(eq(devices.id, deviceId)).get();
      expect(device?.revokedAt).not.toBeNull();
    });

    it('throws when device not found', () => {
      expect(() => revokeDevice(app.db, { deviceId: 'nonexistent-id' })).toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // revoke-invite
  // --------------------------------------------------------------------------
  describe('revokeInvite', () => {
    it('sets revoked_at and does NOT delete the row', () => {
      createGroup(app.db, {
        name: 'RI Group',
        slug: 'ri-group',
        ownerName: 'Kim',
        ownerEmail: 'kim@example.com',
      });

      const { inviteCode } = createInvite(app.db, {
        group: 'ri-group',
        role: 'reader',
      });

      const countBefore = app.db.select().from(invites).all().length;

      revokeInvite(app.db, { group: 'ri-group', code: inviteCode });

      const countAfter = app.db.select().from(invites).all().length;
      expect(countAfter).toBe(countBefore); // no deletion

      const allInvites = app.db.select().from(invites).all();
      expect(allInvites.every((i) => i.revokedAt !== null)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // create-device
  // --------------------------------------------------------------------------
  describe('createDevice', () => {
    it('creates a device for an active member and returns pch_ token', () => {
      createGroup(app.db, {
        name: 'CD Group',
        slug: 'cd-group',
        ownerName: 'Leo',
        ownerEmail: 'leo@example.com',
      });

      const result = createDevice(app.db, {
        group: 'cd-group',
        email: 'leo@example.com',
        label: 'second-device',
      });

      expect(result.deviceToken).toMatch(/^pch_/);
      expect(result.deviceId).toBeTruthy();
    });

    it('stores token_hash, not plain token', () => {
      createGroup(app.db, {
        name: 'CD Hash Group',
        slug: 'cd-hash-group',
        ownerName: 'Mia',
        ownerEmail: 'mia@example.com',
      });

      const result = createDevice(app.db, { group: 'cd-hash-group', email: 'mia@example.com' });

      const device = app.db.select().from(devices).where(eq(devices.id, result.deviceId)).get();

      expect(device?.tokenHash).toBe(hashToken(result.deviceToken));
    });

    it('throws when user is not an active member of the group', () => {
      createGroup(app.db, {
        name: 'CD Err Group',
        slug: 'cd-err-group',
        ownerName: 'Nick',
        ownerEmail: 'nick@example.com',
      });

      expect(() =>
        createDevice(app.db, { group: 'cd-err-group', email: 'nobody@example.com' }),
      ).toThrow();
    });

    it('throws when group does not exist', () => {
      expect(() => createDevice(app.db, { group: 'no-group', email: 'any@example.com' })).toThrow();
    });

    it('throws when member is removed (removedAt not null)', () => {
      const { groupId, userId } = createGroup(app.db, {
        name: 'CD Removed Group',
        slug: 'cd-removed-group',
        ownerName: 'Ora',
        ownerEmail: 'ora@example.com',
      });

      // Mark member as removed directly (no CLI command for that — test helper only)
      app.db
        .update(members)
        .set({ removedAt: new Date().toISOString() })
        .where(eq(members.userId, userId))
        .run();

      expect(() =>
        createDevice(app.db, { group: 'cd-removed-group', email: 'ora@example.com' }),
      ).toThrow();

      // Ensure no extra device was created
      const allDevices = app.db.select().from(devices).where(eq(devices.groupId, groupId)).all();
      expect(allDevices).toHaveLength(1); // only the original owner device
    });
  });
});
