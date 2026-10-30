/**
 * AC7: Invite permissions
 * - editor/reader → 403 on create and revoke
 * - owner/admin → 200
 */

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

const CSRF_HEADERS = {
  'content-type': 'application/json',
  'x-parche-csrf': '1',
};

describe('Invite permissions (AC7)', () => {
  let dataDir: string;
  let app: FastifyInstance;
  let groupSlug: string;

  beforeEach(async () => {
    dataDir = await makeTempDataDir();
    app = await makeApp(dataDir, makeConfig(dataDir, { creators: ['owner@example.com'] }));

    // Create group via admin
    const { groupSlug: slug } = await seedGroupWithDevice(app, {
      slug: 'test-invites',
      ownerEmail: 'owner@example.com',
      ownerName: 'Owner',
    });
    groupSlug = slug;
  });

  afterEach(async () => {
    await app.close();
    await cleanupDir(dataDir);
  });

  async function createInviteAs(role: string): Promise<{
    statusCode: number;
    code?: string;
    inviteId?: string;
  }> {
    const email = `${role}@example.com`;
    const { userId } = seedWebUser(app, { email, name: role });
    seedMember(app, { groupSlug, userId, role });
    const cookie = seedWebSession(app, userId);

    const res = await app.inject({
      method: 'POST',
      url: `/api/web/groups/${groupSlug}/invites`,
      headers: { ...CSRF_HEADERS, cookie: `parche_session=${cookie}` },
      payload: { role: 'reader', expires: 'never' },
    });

    return {
      statusCode: res.statusCode,
      code: res.statusCode === 200 ? res.json().code : undefined,
    };
  }

  it('editor → 403 on create invite', async () => {
    const { statusCode } = await createInviteAs('editor');
    expect(statusCode).toBe(403);
  });

  it('reader → 403 on create invite', async () => {
    const { statusCode } = await createInviteAs('reader');
    expect(statusCode).toBe(403);
  });

  it('owner → 200 on create invite, code returned', async () => {
    const ownerUser = seedWebUser(app, { email: 'owner@example.com', name: 'Owner' });
    const cookie = seedWebSession(app, ownerUser.userId);

    const res = await app.inject({
      method: 'POST',
      url: `/api/web/groups/${groupSlug}/invites`,
      headers: { ...CSRF_HEADERS, cookie: `parche_session=${cookie}` },
      payload: { role: 'editor', expires: '24h' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it('admin → 200 on create invite', async () => {
    const { statusCode, code } = await createInviteAs('admin');
    expect(statusCode).toBe(200);
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it('owner can revoke an invite', async () => {
    // Create invite as owner first
    const ownerUser = seedWebUser(app, { email: 'owner@example.com', name: 'Owner' });
    const ownerCookie = seedWebSession(app, ownerUser.userId);

    const createRes = await app.inject({
      method: 'POST',
      url: `/api/web/groups/${groupSlug}/invites`,
      headers: { ...CSRF_HEADERS, cookie: `parche_session=${ownerCookie}` },
      payload: { role: 'reader', expires: 'never' },
    });
    expect(createRes.statusCode).toBe(200);

    // Get the invite id from DB
    const { invites } = await import('../../db/schema.js');
    const invite = app.db.select({ id: invites.id }).from(invites).get();
    expect(invite?.id).toBeDefined();
    const inviteId = invite?.id as string;

    // Revoke
    const revokeRes = await app.inject({
      method: 'POST',
      url: `/api/web/groups/${groupSlug}/invites/${inviteId}/revoke`,
      headers: { ...CSRF_HEADERS, cookie: `parche_session=${ownerCookie}` },
      payload: {},
    });
    expect(revokeRes.statusCode).toBe(200);

    // Verify revoked
    const revokedInvite = app.db
      .select({ revokedAt: invites.revokedAt })
      .from(invites)
      .where((await import('drizzle-orm')).eq(invites.id, inviteId))
      .get();
    expect(revokedInvite?.revokedAt).not.toBeNull();
  });

  it('editor → 403 on revoke invite', async () => {
    // First create an invite as owner
    const ownerUser = seedWebUser(app, { email: 'owner@example.com', name: 'Owner' });
    const ownerCookie = seedWebSession(app, ownerUser.userId);

    const createRes = await app.inject({
      method: 'POST',
      url: `/api/web/groups/${groupSlug}/invites`,
      headers: { ...CSRF_HEADERS, cookie: `parche_session=${ownerCookie}` },
      payload: { role: 'reader', expires: 'never' },
    });
    expect(createRes.statusCode).toBe(200);

    const { invites } = await import('../../db/schema.js');
    const invite = app.db.select({ id: invites.id }).from(invites).get();
    const inviteId = invite?.id as string;

    // Editor tries to revoke
    const editorUser = seedWebUser(app, { email: 'editor2@example.com', name: 'Editor' });
    seedMember(app, { groupSlug, userId: editorUser.userId, role: 'editor' });
    const editorCookie = seedWebSession(app, editorUser.userId);

    const revokeRes = await app.inject({
      method: 'POST',
      url: `/api/web/groups/${groupSlug}/invites/${inviteId}/revoke`,
      headers: { ...CSRF_HEADERS, cookie: `parche_session=${editorCookie}` },
      payload: {},
    });
    expect(revokeRes.statusCode).toBe(403);
  });

  it('admin creating invite with role=owner → 400', async () => {
    const adminUser = seedWebUser(app, { email: 'admin@example.com', name: 'Admin' });
    seedMember(app, { groupSlug, userId: adminUser.userId, role: 'admin' });
    const adminCookie = seedWebSession(app, adminUser.userId);

    const res = await app.inject({
      method: 'POST',
      url: `/api/web/groups/${groupSlug}/invites`,
      headers: { ...CSRF_HEADERS, cookie: `parche_session=${adminCookie}` },
      payload: { role: 'owner', expires: 'never' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_request');
  });

  it('legacy invite with code_hint IS NULL shows ••••-•••• in list', async () => {
    const { invites: invitesTable } = await import('../../db/schema.js');
    const { newId } = await import('../../ids.js');
    const { hashInviteCode, generateInviteCode } = await import('../../auth/tokens.js');
    const { eq } = await import('drizzle-orm');

    const ownerUser = seedWebUser(app, { email: 'owner@example.com', name: 'Owner' });
    const ownerCookie = seedWebSession(app, ownerUser.userId);

    // Manually insert an invite with NULL code_hint to simulate legacy data
    const grpRow = app.db
      .select({ id: (await import('../../db/schema.js')).groups.id })
      .from((await import('../../db/schema.js')).groups)
      .where(eq((await import('../../db/schema.js')).groups.slug, groupSlug))
      .get();
    const code = generateInviteCode();
    const codeHash = hashInviteCode(code);
    const now = new Date().toISOString();
    app.db
      .insert(invitesTable)
      .values({
        id: newId(),
        groupId: grpRow?.id as string,
        codeHash,
        codeHint: null, // legacy — no hint
        role: 'editor',
        createdBy: ownerUser.userId,
        expiresAt: null,
        maxUses: null,
        uses: 0,
        createdAt: now,
      })
      .run();

    const res = await app.inject({
      method: 'GET',
      url: `/api/web/groups/${groupSlug}/invites`,
      headers: { cookie: `parche_session=${ownerCookie}` },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<{ codeDisplay: string }>;
    expect(list).toHaveLength(1);
    expect(list[0]?.codeDisplay).toBe('••••-••••');
  });
});
