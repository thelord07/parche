/**
 * A3: Security matrix tests for /api/web/g/:slug/* endpoints
 * Tests: no session → 401, other group → 404, removed member → 404, nonexistent group → 404
 * Also: path traversal negative tests
 */

import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { members } from '../../db/schema.js';
import {
  cleanupDir,
  makeApp,
  makeTempDataDir,
  seedGroupWithDevice,
  seedMember,
  seedWebSession,
  seedWebUser,
  withWebFixture,
} from '../../test-helpers.js';

async function setup() {
  const dataDir = await makeTempDataDir();
  const { webDir, cleanup: webCleanup } = await withWebFixture();
  const app = await makeApp(dataDir, {}, { webDir });
  await app.ready();

  // Group 1 (main test group)
  const group1 = await seedGroupWithDevice(app, { slug: 'group-alpha' });
  const user1 = seedWebUser(app, { email: 'user1@example.com' });
  const session1 = seedWebSession(app, user1.userId);
  seedMember(app, { groupSlug: 'group-alpha', userId: user1.userId, role: 'editor' });

  // Group 2 (other group — user1 is NOT a member)
  const group2 = await seedGroupWithDevice(app, { slug: 'group-beta' });

  // User 2 (not a member of group-alpha)
  const user2 = seedWebUser(app, { email: 'user2@example.com' });
  const session2 = seedWebSession(app, user2.userId);

  return {
    dataDir,
    webDir,
    webCleanup,
    app,
    group1,
    group2,
    user1,
    user2,
    session1,
    session2,
    cleanup: async () => {
      await app.close();
      await cleanupDir(dataDir);
      await webCleanup();
    },
  };
}

const ENDPOINTS = [
  '/api/web/g/group-alpha/summary',
  '/api/web/g/group-alpha/tree',
  '/api/web/g/group-alpha/activity',
  '/api/web/g/group-alpha/note?path=test.md',
  '/api/web/g/group-alpha/conflicts',
  '/api/web/g/group-alpha/topics',
];

describe('A3: security matrix for /api/web/g/:slug/* endpoints', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  for (const endpoint of ENDPOINTS) {
    it(`401 without session: ${endpoint}`, async () => {
      const res = await ctx.app.inject({ method: 'GET', url: endpoint });
      expect(res.statusCode).toBe(401);
    });

    it(`404 for other group member (user2 not in group-alpha): ${endpoint}`, async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: endpoint,
        cookies: { parche_session: ctx.session2 },
      });
      expect(res.statusCode).toBe(404);
    });

    it(`404 for nonexistent group: ${endpoint.replace('group-alpha', 'no-such-group')}`, async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: endpoint.replace('group-alpha', 'no-such-group'),
        cookies: { parche_session: ctx.session1 },
      });
      expect(res.statusCode).toBe(404);
    });
  }

  it('404 for removed member', async () => {
    // Remove user1 from group-alpha
    ctx.app.db
      .update(members)
      .set({ removedAt: new Date().toISOString() })
      .where(and(eq(members.groupId, ctx.group1.groupId), eq(members.userId, ctx.user1.userId)))
      .run();

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/group-alpha/summary',
      cookies: { parche_session: ctx.session1 },
    });
    expect(res.statusCode).toBe(404);
  });

  it('path traversal: slug with .. returns 404', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/../etc/passwd/summary',
      cookies: { parche_session: ctx.session1 },
    });
    expect([404, 400]).toContain(res.statusCode);
  });

  it('path traversal: path query with .. returns 400 or 404', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/group-alpha/note?path=../../etc/passwd',
      cookies: { parche_session: ctx.session1 },
    });
    expect([400, 404]).toContain(res.statusCode);
  });

  it('path traversal: /raw with .. returns 400', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/group-alpha/raw?path=../../etc/passwd',
      cookies: { parche_session: ctx.session1 },
    });
    expect([400, 404, 415]).toContain(res.statusCode);
  });

  it('200 for valid member (smoke test)', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/group-alpha/summary',
      cookies: { parche_session: ctx.session1 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.group.slug).toBe('group-alpha');
  });
});
