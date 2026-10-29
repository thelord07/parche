import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGroup, createInvite } from '../admin/commands.js';
import { devices } from '../db/schema.js';
import { cleanupDir, makeApp, makeTempDataDir, seedGroupWithDevice } from '../test-helpers.js';

describe('auth plugin', () => {
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
  // AC5 — 401 conditions
  // --------------------------------------------------------------------------
  describe('AC5: 401 cases', () => {
    it('missing Authorization header → 401 on /changes', async () => {
      const { groupSlug } = await seedGroupWithDevice(app);
      const res = await app.inject({ method: 'GET', url: `/api/g/${groupSlug}/changes` });
      expect(res.statusCode).toBe(401);
    });

    it('malformed header (no Bearer prefix) → 401', async () => {
      const { groupSlug } = await seedGroupWithDevice(app);
      const res = await app.inject({
        method: 'GET',
        url: `/api/g/${groupSlug}/changes`,
        headers: { authorization: 'Token abc123' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('token without pch_ prefix → 401', async () => {
      const { groupSlug } = await seedGroupWithDevice(app);
      const res = await app.inject({
        method: 'GET',
        url: `/api/g/${groupSlug}/changes`,
        headers: { authorization: 'Bearer notapchtoken_abc123' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('unknown token → 401', async () => {
      const { groupSlug } = await seedGroupWithDevice(app);
      const res = await app.inject({
        method: 'GET',
        url: `/api/g/${groupSlug}/changes`,
        headers: { authorization: 'Bearer pch_unknownunknownunknownunknownunknownunknown' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('revoked device token → 401', async () => {
      const { token, authHeader, groupSlug, deviceId } = await seedGroupWithDevice(app);

      // Revoke the device directly
      app.db
        .update(devices)
        .set({ revokedAt: new Date().toISOString() })
        .where(eq(devices.id, deviceId))
        .run();

      const res = await app.inject({
        method: 'GET',
        url: `/api/g/${groupSlug}/changes`,
        headers: { authorization: authHeader },
      });
      expect(res.statusCode).toBe(401);
      void token; // used above via authHeader
    });

    it('removed member → 401', async () => {
      const { authHeader, groupSlug, userId } = await seedGroupWithDevice(app);

      // Mark the member as removed
      const { members } = await import('../db/schema.js');
      app.db
        .update(members)
        .set({ removedAt: new Date().toISOString() })
        .where(eq(members.userId, userId))
        .run();

      const res = await app.inject({
        method: 'GET',
        url: `/api/g/${groupSlug}/changes`,
        headers: { authorization: authHeader },
      });
      expect(res.statusCode).toBe(401);
    });

    it('token from group A used on /api/g/B/changes → 401', async () => {
      const { authHeader } = await seedGroupWithDevice(app, { slug: 'group-a' });
      await seedGroupWithDevice(app, { slug: 'group-b' });

      const res = await app.inject({
        method: 'GET',
        url: '/api/g/group-b/changes',
        headers: { authorization: authHeader },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // --------------------------------------------------------------------------
  // Happy path — last_seen_at is updated
  // --------------------------------------------------------------------------
  it('successful auth updates last_seen_at', async () => {
    const { authHeader, deviceId, groupSlug } = await seedGroupWithDevice(app);

    const before = app.db
      .select({ lastSeenAt: devices.lastSeenAt })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .get();
    expect(before?.lastSeenAt).toBeNull();

    await app.inject({
      method: 'GET',
      url: `/api/g/${groupSlug}/changes`,
      headers: { authorization: authHeader },
    });

    const after = app.db
      .select({ lastSeenAt: devices.lastSeenAt })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .get();
    expect(after?.lastSeenAt).not.toBeNull();
  });

  // --------------------------------------------------------------------------
  // requireCan — 403 for readers on write
  // --------------------------------------------------------------------------
  it('reader gets 403 on /push (requireCan write)', async () => {
    createGroup(app.db, {
      name: 'Can Group',
      slug: 'can-group',
      ownerName: 'Owner',
      ownerEmail: 'owner@can.com',
    });

    const { inviteCode } = createInvite(app.db, { group: 'can-group', role: 'reader' });

    // Join as reader
    const joinRes = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { code: inviteCode, name: 'Reader', email: 'reader@can.com' },
    });
    expect(joinRes.statusCode).toBe(200);
    const readerToken = (joinRes.json() as { deviceToken: string }).deviceToken;

    const res = await app.inject({
      method: 'POST',
      url: '/api/g/can-group/push',
      headers: {
        authorization: `Bearer ${readerToken}`,
        'content-type': 'application/json',
      },
      payload: { protocol: 1, changes: [] },
    });
    expect(res.statusCode).toBe(403);
  });
});
