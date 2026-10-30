/**
 * SPA body compatibility tests.
 *
 * (b) Verifies that the SPA's exact wire format — payload: '{}', content-type:
 *     application/json, x-parche-csrf: 1 — is accepted by both:
 *       - POST /api/web/groups/:slug/invites/:id/revoke  → 200, invite revoked
 *       - POST /api/web/auth/logout                     → 200, session revoked
 *
 * (c) Regression: sending content-type: application/json with a truly empty
 *     body string (not '{}') must return 400 (FST_ERR_CTP_EMPTY_JSON_BODY).
 *     This documents why the client must always send at least '{}' on mutations.
 */

import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invites, sessions } from '../../db/schema.js';
import {
  cleanupDir,
  makeApp,
  makeConfig,
  makeTempDataDir,
  seedGroupWithDevice,
  seedMember,
  seedWebSession,
  seedWebUser,
} from '../../test-helpers.js';

const SPA_HEADERS = {
  'content-type': 'application/json',
  'x-parche-csrf': '1',
} as const;

describe('SPA body compatibility (b+c)', () => {
  let dataDir: string;
  let app: FastifyInstance;
  let groupSlug: string;

  beforeEach(async () => {
    dataDir = await makeTempDataDir();
    app = await makeApp(dataDir, makeConfig(dataDir, { creators: ['owner@example.com'] }));

    const { groupSlug: slug } = await seedGroupWithDevice(app, {
      slug: 'spa-body-test',
      ownerEmail: 'owner@example.com',
      ownerName: 'Owner',
    });
    groupSlug = slug;
  });

  afterEach(async () => {
    await app.close();
    await cleanupDir(dataDir);
  });

  // Helper: creates one invite and returns its id from the list endpoint
  async function createAndGetInviteId(cookie: string): Promise<string> {
    const createRes = await app.inject({
      method: 'POST',
      url: `/api/web/groups/${groupSlug}/invites`,
      headers: { ...SPA_HEADERS, cookie: `parche_session=${cookie}` },
      payload: { role: 'reader', expires: 'never' },
    });
    expect(createRes.statusCode).toBe(200);

    const listRes = await app.inject({
      method: 'GET',
      url: `/api/web/groups/${groupSlug}/invites`,
      headers: { cookie: `parche_session=${cookie}` },
    });
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json() as [{ id: string }, ...Array<{ id: string }>];
    return list[0].id;
  }

  // (b1) revokeInvite with payload '{}'
  it('(b) revokeInvite: payload="{}" → 200 and invite is revoked', async () => {
    const ownerUser = seedWebUser(app, { email: 'owner@example.com', name: 'Owner' });
    const ownerCookie = seedWebSession(app, ownerUser.userId);
    const inviteId = await createAndGetInviteId(ownerCookie);

    // Revoke with the SPA's exact wire format: payload = '{}'
    const revokeRes = await app.inject({
      method: 'POST',
      url: `/api/web/groups/${groupSlug}/invites/${inviteId}/revoke`,
      headers: { ...SPA_HEADERS, cookie: `parche_session=${ownerCookie}` },
      payload: '{}',
    });
    expect(revokeRes.statusCode).toBe(200);
    expect(revokeRes.json()).toMatchObject({ ok: true });

    // Verify the invite is marked revoked in the DB
    const row = app.db
      .select({ revokedAt: invites.revokedAt })
      .from(invites)
      .where(eq(invites.id, inviteId))
      .get();
    expect(row?.revokedAt).not.toBeNull();
  });

  // (b2) logout with payload '{}'
  it('(b) logout: payload="{}" → 200 and session is revoked', async () => {
    const { userId } = seedWebUser(app, { email: 'user@example.com', name: 'User' });
    const cookie = seedWebSession(app, userId);

    // Confirm session is active
    const meRes = await app.inject({
      method: 'GET',
      url: '/api/web/me',
      headers: { cookie: `parche_session=${cookie}` },
    });
    expect(meRes.statusCode).toBe(200);

    // Logout with the SPA's exact wire format: payload = '{}'
    const logoutRes = await app.inject({
      method: 'POST',
      url: '/api/web/auth/logout',
      headers: { ...SPA_HEADERS, cookie: `parche_session=${cookie}` },
      payload: '{}',
    });
    expect(logoutRes.statusCode).toBe(200);

    // Verify session is revoked in DB
    const { hashToken } = await import('../../auth/tokens.js');
    const tokenHash = hashToken(cookie);
    const row = app.db
      .select({ revokedAt: sessions.revokedAt })
      .from(sessions)
      .where(eq(sessions.tokenHash, tokenHash))
      .get();
    expect(row?.revokedAt).not.toBeNull();
  });

  // (c) regression: truly empty body with JSON content-type → 400
  it('(c) empty body string with content-type: application/json → 400', async () => {
    const ownerUser = seedWebUser(app, { email: 'owner@example.com', name: 'Owner' });
    const ownerCookie = seedWebSession(app, ownerUser.userId);
    const inviteId = await createAndGetInviteId(ownerCookie);

    // Send an empty string body — Fastify must reject with 400
    const badRes = await app.inject({
      method: 'POST',
      url: `/api/web/groups/${groupSlug}/invites/${inviteId}/revoke`,
      headers: { ...SPA_HEADERS, cookie: `parche_session=${ownerCookie}` },
      payload: '',
    });
    expect(badRes.statusCode).toBe(400);
  });

  // (b3) editor cannot revoke (403) — the SPA body format doesn't bypass permissions
  it('(b) editor revoking with payload="{}" → 403', async () => {
    const editorUser = seedWebUser(app, { email: 'editor@example.com', name: 'Editor' });
    seedMember(app, { groupSlug, userId: editorUser.userId, role: 'editor' });
    const editorCookie = seedWebSession(app, editorUser.userId);

    const ownerUser = seedWebUser(app, { email: 'owner@example.com', name: 'Owner' });
    const ownerCookie = seedWebSession(app, ownerUser.userId);
    const inviteId = await createAndGetInviteId(ownerCookie);

    // Editor tries to revoke with '{}'
    const revokeRes = await app.inject({
      method: 'POST',
      url: `/api/web/groups/${groupSlug}/invites/${inviteId}/revoke`,
      headers: { ...SPA_HEADERS, cookie: `parche_session=${editorCookie}` },
      payload: '{}',
    });
    expect(revokeRes.statusCode).toBe(403);

    // Invite NOT revoked
    const row = app.db
      .select({ revokedAt: invites.revokedAt })
      .from(invites)
      .where(and(eq(invites.id, inviteId), isNull(invites.revokedAt)))
      .get();
    expect(row).toBeDefined();
  });
});
