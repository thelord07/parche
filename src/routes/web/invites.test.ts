/**
 * AC7: Invite permissions
 * - editor/reader → 403 on create and revoke
 * - owner/admin → 200
 *
 * M1: active invites list excludes expired and exhausted invites (in addition to revoked).
 * M2: maxUses accepts only integers >= 1 or null/absent; 2.5, 0, -1, "3" → 400.
 */

import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateInviteCode, hashInviteCode } from '../../auth/tokens.js';
import { groups, invites as invitesTable } from '../../db/schema.js';
import { newId } from '../../ids.js';
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

// ---------------------------------------------------------------------------
// M1: active invites list excludes expired and exhausted invites
// ---------------------------------------------------------------------------

describe('M1 — GET /api/web/groups/:slug/invites excludes expired and exhausted', () => {
  let dataDir: string;
  let app: FastifyInstance;
  let groupSlug: string;
  let ownerCookie: string;
  let grpId: string;
  let ownerUserId: string;

  beforeEach(async () => {
    dataDir = await makeTempDataDir();
    app = await makeApp(dataDir, makeConfig(dataDir, { creators: ['owner@example.com'] }));

    const { groupSlug: slug } = await seedGroupWithDevice(app, {
      slug: 'test-m1',
      ownerEmail: 'owner@example.com',
      ownerName: 'Owner',
    });
    groupSlug = slug;

    const ownerUser = seedWebUser(app, { email: 'owner@example.com', name: 'Owner' });
    ownerUserId = ownerUser.userId;
    ownerCookie = seedWebSession(app, ownerUserId);

    const grp = app.db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.slug, groupSlug))
      .get();
    grpId = grp?.id as string;
  });

  afterEach(async () => {
    await app.close();
    await cleanupDir(dataDir);
  });

  function insertInvite(opts: {
    expiresAt: string | null;
    maxUses: number | null;
    uses: number;
    revokedAt?: string | null;
  }) {
    const code = generateInviteCode();
    const codeHash = hashInviteCode(code);
    const codeHint = code.split('-')[0] ?? null;
    const now = new Date().toISOString();
    const id = newId();
    app.db
      .insert(invitesTable)
      .values({
        id,
        groupId: grpId,
        codeHash,
        codeHint,
        role: 'reader',
        createdBy: ownerUserId,
        expiresAt: opts.expiresAt,
        maxUses: opts.maxUses,
        uses: opts.uses,
        revokedAt: opts.revokedAt ?? null,
        createdAt: now,
      })
      .run();
    return id;
  }

  it('active invite (not expired, not exhausted) appears in list', async () => {
    insertInvite({ expiresAt: new Date(Date.now() + 86400000).toISOString(), maxUses: 5, uses: 2 });

    const res = await app.inject({
      method: 'GET',
      url: `/api/web/groups/${groupSlug}/invites`,
      headers: { cookie: `parche_session=${ownerCookie}` },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as unknown[];
    expect(list).toHaveLength(1);
  });

  it('expired invite (expiresAt <= now) is excluded from list', async () => {
    // expires_at in the past
    const pastTime = new Date(Date.now() - 1000).toISOString();
    insertInvite({ expiresAt: pastTime, maxUses: null, uses: 0 });

    const res = await app.inject({
      method: 'GET',
      url: `/api/web/groups/${groupSlug}/invites`,
      headers: { cookie: `parche_session=${ownerCookie}` },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as unknown[];
    expect(list).toHaveLength(0);
  });

  it('exhausted invite (uses >= maxUses) is excluded from list', async () => {
    insertInvite({ expiresAt: null, maxUses: 3, uses: 3 });

    const res = await app.inject({
      method: 'GET',
      url: `/api/web/groups/${groupSlug}/invites`,
      headers: { cookie: `parche_session=${ownerCookie}` },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as unknown[];
    expect(list).toHaveLength(0);
  });

  it('revoked invite is excluded from list (existing behavior)', async () => {
    insertInvite({ expiresAt: null, maxUses: null, uses: 0, revokedAt: new Date().toISOString() });

    const res = await app.inject({
      method: 'GET',
      url: `/api/web/groups/${groupSlug}/invites`,
      headers: { cookie: `parche_session=${ownerCookie}` },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as unknown[];
    expect(list).toHaveLength(0);
  });

  it('mix: active + expired + exhausted → only active returned', async () => {
    // Active: expires far future, uses under maxUses
    insertInvite({ expiresAt: new Date(Date.now() + 86400000).toISOString(), maxUses: 5, uses: 2 });
    // Expired
    insertInvite({ expiresAt: new Date(Date.now() - 1000).toISOString(), maxUses: null, uses: 0 });
    // Exhausted
    insertInvite({ expiresAt: null, maxUses: 2, uses: 2 });

    const res = await app.inject({
      method: 'GET',
      url: `/api/web/groups/${groupSlug}/invites`,
      headers: { cookie: `parche_session=${ownerCookie}` },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as unknown[];
    expect(list).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// M2: maxUses validation — only integers >= 1 or null/absent accepted
// ---------------------------------------------------------------------------

describe('M2 — POST /api/web/groups/:slug/invites validates maxUses', () => {
  let dataDir: string;
  let app: FastifyInstance;
  let groupSlug: string;
  let ownerCookie: string;

  beforeEach(async () => {
    dataDir = await makeTempDataDir();
    app = await makeApp(dataDir, makeConfig(dataDir, { creators: ['owner@example.com'] }));

    const { groupSlug: slug } = await seedGroupWithDevice(app, {
      slug: 'test-m2',
      ownerEmail: 'owner@example.com',
      ownerName: 'Owner',
    });
    groupSlug = slug;

    const ownerUser = seedWebUser(app, { email: 'owner@example.com', name: 'Owner' });
    ownerCookie = seedWebSession(app, ownerUser.userId);
  });

  afterEach(async () => {
    await app.close();
    await cleanupDir(dataDir);
  });

  async function createInviteWithMaxUses(maxUses: unknown) {
    return app.inject({
      method: 'POST',
      url: `/api/web/groups/${groupSlug}/invites`,
      headers: { ...CSRF_HEADERS, cookie: `parche_session=${ownerCookie}` },
      payload: { role: 'reader', expires: 'never', maxUses },
    });
  }

  it('maxUses=1 → 200 (valid integer)', async () => {
    const res = await createInviteWithMaxUses(1);
    expect(res.statusCode).toBe(200);
  });

  it('maxUses=10 → 200 (valid integer)', async () => {
    const res = await createInviteWithMaxUses(10);
    expect(res.statusCode).toBe(200);
  });

  it('maxUses absent (null body field) → 200 (unlimited)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/web/groups/${groupSlug}/invites`,
      headers: { ...CSRF_HEADERS, cookie: `parche_session=${ownerCookie}` },
      payload: { role: 'reader', expires: 'never' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('maxUses=null → 200 (explicitly null = unlimited)', async () => {
    const res = await createInviteWithMaxUses(null);
    expect(res.statusCode).toBe(200);
  });

  it('maxUses=2.5 → 400 (decimal rejected)', async () => {
    const res = await createInviteWithMaxUses(2.5);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_request');
  });

  it('maxUses=0 → 400 (zero rejected)', async () => {
    const res = await createInviteWithMaxUses(0);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_request');
  });

  it('maxUses=-1 → 400 (negative rejected)', async () => {
    const res = await createInviteWithMaxUses(-1);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_request');
  });

  it('maxUses="3" (string) → 400 (string rejected)', async () => {
    const res = await createInviteWithMaxUses('3');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_request');
  });
});
