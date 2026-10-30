/**
 * AC6: POST /api/web/groups
 * - non-creator → 403
 * - creator → 200, owner
 * - duplicate slug → 409
 */

import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { members } from '../../db/schema.js';
import {
  cleanupDir,
  makeApp,
  makeConfig,
  makeTempDataDir,
  seedWebSession,
  seedWebUser,
} from '../../test-helpers.js';

const CSRF_HEADERS = {
  'content-type': 'application/json',
  'x-parche-csrf': '1',
};

describe('POST /api/web/groups (AC6)', () => {
  let dataDir: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    dataDir = await makeTempDataDir();
    app = await makeApp(dataDir, makeConfig(dataDir, { creators: ['creator@example.com'] }));
  });

  afterEach(async () => {
    await app.close();
    await cleanupDir(dataDir);
  });

  it('non-creator user → 403', async () => {
    const { userId } = seedWebUser(app, { email: 'regular@example.com' });
    const cookie = seedWebSession(app, userId);

    const res = await app.inject({
      method: 'POST',
      url: '/api/web/groups',
      headers: { ...CSRF_HEADERS, cookie: `parche_session=${cookie}` },
      payload: { name: 'My Group', slug: 'my-group' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('creator creates group → 200, becomes owner', async () => {
    const { userId } = seedWebUser(app, { email: 'creator@example.com' });
    const cookie = seedWebSession(app, userId);

    const res = await app.inject({
      method: 'POST',
      url: '/api/web/groups',
      headers: { ...CSRF_HEADERS, cookie: `parche_session=${cookie}` },
      payload: { name: 'Backend Lapzo', slug: 'backend-lapzo' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ slug: 'backend-lapzo', name: 'Backend Lapzo' });

    // Verify owner membership
    const { groupId } = res.json();
    const member = app.db
      .select({ role: members.role })
      .from(members)
      .where(eq(members.groupId, groupId))
      .get();
    expect(member?.role).toBe('owner');
  });

  it('duplicate slug → 409 (via SQLITE_CONSTRAINT_UNIQUE)', async () => {
    const { userId } = seedWebUser(app, { email: 'creator@example.com' });
    const cookie = seedWebSession(app, userId);

    // First create
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/web/groups',
      headers: { ...CSRF_HEADERS, cookie: `parche_session=${cookie}` },
      payload: { name: 'Backend Lapzo', slug: 'backend-lapzo' },
    });
    expect(res1.statusCode).toBe(200);

    // Duplicate
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/web/groups',
      headers: { ...CSRF_HEADERS, cookie: `parche_session=${cookie}` },
      payload: { name: 'Backend Lapzo 2', slug: 'backend-lapzo' },
    });
    expect(res2.statusCode).toBe(409);
    expect(res2.json()).toMatchObject({ error: 'slug_taken' });
  });

  it('no session → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/web/groups',
      headers: CSRF_HEADERS,
      payload: { name: 'X', slug: 'x-slug' },
    });
    expect(res.statusCode).toBe(401);
  });
});
