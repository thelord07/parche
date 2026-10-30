import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGroup, createInvite } from '../admin/commands.js';
import { devices, invites, members } from '../db/schema.js';
import { cleanupDir, makeApp, makeTempDataDir } from '../test-helpers.js';
import { resetInviteRateLimit } from './invite-rate-limit.js';

describe('POST /api/join', () => {
  let dataDir: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    resetInviteRateLimit();
    dataDir = await makeTempDataDir();
    app = await makeApp(dataDir);
  });

  afterEach(async () => {
    await app.close();
    await cleanupDir(dataDir);
    resetInviteRateLimit();
  });

  function setupGroup(slug = 'test-group') {
    createGroup(app.db, {
      name: 'Test Group',
      slug,
      ownerName: 'Owner',
      ownerEmail: `owner-${slug}@test.com`,
    });
    const { inviteCode } = createInvite(app.db, { group: slug, role: 'editor' });
    return inviteCode;
  }

  // --------------------------------------------------------------------------
  // AC3: join creates only hashed values — no plain token or code in DB
  // --------------------------------------------------------------------------
  describe('AC3: only hashes stored', () => {
    it('returns deviceToken in response and stores only hash in DB', async () => {
      const code = setupGroup('ac3-group');
      const res = await app.inject({
        method: 'POST',
        url: '/api/join',
        payload: { code, name: 'Alice', email: 'alice@example.com' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { deviceToken: string };
      expect(body.deviceToken).toMatch(/^pch_/);

      // Verify no plain token in devices table
      const allDevices = app.db.select().from(devices).all();
      for (const d of allDevices) {
        expect(d.tokenHash).not.toContain('pch_');
        expect(d.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      }

      // Verify no plain code in invites table
      const allInvites = app.db.select().from(invites).all();
      for (const inv of allInvites) {
        expect(inv.codeHash).not.toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
        expect(inv.codeHash).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it('response conforms to joinResponseSchema shape', async () => {
      const code = setupGroup('ac3b-group');
      const res = await app.inject({
        method: 'POST',
        url: '/api/join',
        payload: { code, name: 'Bob', email: 'bob@example.com' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        group: { id: string; slug: string; name: string };
        role: string;
        deviceToken: string;
        user: { id: string; name: string };
      };
      expect(body.group.slug).toBe('ac3b-group');
      expect(body.role).toBe('editor');
      expect(body.user.name).toBe('Bob');
      expect(body.deviceToken).toMatch(/^pch_/);
    });
  });

  // --------------------------------------------------------------------------
  // AC4: rate limiting — 11th request on /api/join → 429
  // --------------------------------------------------------------------------
  describe('AC4: rate limiting', () => {
    it('11 failed joins → 429 on the 11th (default max=10)', async () => {
      // Use an invalid code so all 10 "allowed" attempts are 404, then the 11th is 429
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/join',
          payload: { code: 'XXXX-XXXX', name: 'Test', email: 'test@example.com' },
        });
        statuses.push(res.statusCode);
      }
      // First 10 are 404 (invalid code), 11th is 429
      expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
      expect(statuses[10]).toBe(429);
    });

    it('11 authenticated /changes requests → none gets 429', async () => {
      // Seed a group with a device
      createGroup(app.db, {
        name: 'Rate Limit Group',
        slug: 'rate-limit-group',
        ownerName: 'Owner',
        ownerEmail: 'rl-owner@example.com',
      });
      // Join to get a token
      const { inviteCode } = createInvite(app.db, { group: 'rate-limit-group', role: 'reader' });
      const joinRes = await app.inject({
        method: 'POST',
        url: '/api/join',
        payload: { code: inviteCode, name: 'Reader', email: 'reader@example.com' },
      });
      const { deviceToken } = joinRes.json() as { deviceToken: string };

      // Make 11 authenticated requests to /changes — none should be rate-limited
      for (let i = 0; i < 11; i++) {
        const res = await app.inject({
          method: 'GET',
          url: '/api/g/rate-limit-group/changes',
          headers: { authorization: `Bearer ${deviceToken}` },
        });
        expect(res.statusCode).toBe(200);
      }
    });
  });

  // --------------------------------------------------------------------------
  // Already-active member → 409
  // --------------------------------------------------------------------------
  it('active member joining with reader code → 409, uses unchanged, no new device, role unchanged', async () => {
    createGroup(app.db, {
      name: 'Already Group',
      slug: 'already-group',
      ownerName: 'Owner',
      ownerEmail: 'owner@already.com',
    });
    const { inviteCode } = createInvite(app.db, { group: 'already-group', role: 'reader' });

    // First join succeeds
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { code: inviteCode, name: 'Owner', email: 'owner@already.com' },
    });
    expect(res1.statusCode).toBe(409);
    const body = res1.json() as { error: string; message: string };
    expect(body.error).toBe('already_member');

    // uses not consumed
    const inv = app.db.select().from(invites).all()[0];
    expect(inv?.uses).toBe(0);

    // no new device created (only the original owner device exists)
    const allDevices = app.db.select().from(devices).all();
    expect(allDevices).toHaveLength(1);

    // owner role unchanged
    const m = app.db.select().from(members).all()[0];
    expect(m?.role).toBe('owner');
  });

  // --------------------------------------------------------------------------
  // Removed member re-join
  // --------------------------------------------------------------------------
  it('removed ex-admin re-joins with reader code → becomes reader, old tokens 401, new token works', async () => {
    createGroup(app.db, {
      name: 'Rejoin Group',
      slug: 'rejoin-group',
      ownerName: 'Owner',
      ownerEmail: 'owner@rejoin.com',
    });

    // Give member an invite code to join as admin first via admin command
    const { inviteCode: adminCode } = createInvite(app.db, {
      group: 'rejoin-group',
      role: 'admin',
    });
    const adminJoinRes = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { code: adminCode, name: 'Ex Admin', email: 'exadmin@rejoin.com' },
    });
    expect(adminJoinRes.statusCode).toBe(200);
    const oldToken = (adminJoinRes.json() as { deviceToken: string }).deviceToken;

    // Simulate removal: set removed_at on member
    const { id: userId } = (adminJoinRes.json() as { user: { id: string } }).user;
    app.db
      .update(members)
      .set({ removedAt: new Date().toISOString() })
      .where(eq(members.userId, userId))
      .run();

    // Old token should now give 401
    const oldRes = await app.inject({
      method: 'GET',
      url: '/api/g/rejoin-group/changes',
      headers: { authorization: `Bearer ${oldToken}` },
    });
    expect(oldRes.statusCode).toBe(401);

    // Re-join with a reader invite
    const { inviteCode: readerCode } = createInvite(app.db, {
      group: 'rejoin-group',
      role: 'reader',
    });
    const rejoinRes = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { code: readerCode, name: 'Ex Admin', email: 'exadmin@rejoin.com' },
    });
    expect(rejoinRes.statusCode).toBe(200);
    const newToken = (rejoinRes.json() as { deviceToken: string }).deviceToken;

    // New token works
    const newRes = await app.inject({
      method: 'GET',
      url: '/api/g/rejoin-group/changes',
      headers: { authorization: `Bearer ${newToken}` },
    });
    expect(newRes.statusCode).toBe(200);

    // Role is now reader
    const m = app.db.select().from(members).where(eq(members.userId, userId)).get();
    expect(m?.role).toBe('reader');
    expect(m?.removedAt).toBeNull();

    // Revocation is confirmed by the 401 check above (oldRes.statusCode === 401)
  });

  // --------------------------------------------------------------------------
  // Invalid invite code / expired / exhausted → 404 (generic)
  // --------------------------------------------------------------------------
  it('unknown code → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { code: 'AAAA-BBBB', name: 'Test', email: 'test@example.com' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('bad body (missing code) → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { name: 'Test', email: 'test@example.com' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('exhausted invite (maxUses=1 used once) → 404 on second attempt', async () => {
    createGroup(app.db, {
      name: 'Exhaust Group',
      slug: 'exhaust-group',
      ownerName: 'Owner',
      ownerEmail: 'owner@exhaust.com',
    });
    const { inviteCode } = createInvite(app.db, {
      group: 'exhaust-group',
      role: 'editor',
      maxUses: 1,
    });

    const res1 = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { code: inviteCode, name: 'Alice', email: 'alice@exhaust.com' },
    });
    expect(res1.statusCode).toBe(200);

    const res2 = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { code: inviteCode, name: 'Bob', email: 'bob@exhaust.com' },
    });
    expect(res2.statusCode).toBe(404);
  });
});
