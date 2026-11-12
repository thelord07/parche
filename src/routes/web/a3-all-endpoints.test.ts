/**
 * A3 (complete): security matrix for ALL /api/web/g/:slug/* endpoints,
 * including those added in PARCHE-007-A that were missing from the original
 * group-read.test.ts:
 *   /note/version, /diff, /raw, /conflicts/view, /topics/:tag
 *
 * For every endpoint:
 *   - 401 without session
 *   - 404 for a user who is not a member (other group)
 *   - 404 for a nonexistent group
 *   - 404 for a removed member (removedAt set)
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

  const group1 = await seedGroupWithDevice(app, { slug: 'grp-a3' });
  const user1 = seedWebUser(app, { email: 'a3user1@example.com' });
  const session1 = seedWebSession(app, user1.userId);
  seedMember(app, { groupSlug: 'grp-a3', userId: user1.userId, role: 'editor' });

  // Second user who is NOT a member of grp-a3
  const user2 = seedWebUser(app, { email: 'a3user2@example.com' });
  const session2 = seedWebSession(app, user2.userId);

  return {
    dataDir,
    webDir,
    webCleanup,
    app,
    group1,
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

// Full list of endpoints (including new ones from PARCHE-007-A)
const ALL_ENDPOINTS = [
  // original endpoints
  '/api/web/g/grp-a3/summary',
  '/api/web/g/grp-a3/tree',
  '/api/web/g/grp-a3/activity',
  '/api/web/g/grp-a3/note?path=test.md',
  '/api/web/g/grp-a3/conflicts',
  '/api/web/g/grp-a3/topics',
  // new endpoints (PARCHE-007-A)
  '/api/web/g/grp-a3/note/version?path=test.md&seq=1',
  '/api/web/g/grp-a3/diff?path=test.md&from=1&to=2',
  '/api/web/g/grp-a3/raw?path=test.md',
  '/api/web/g/grp-a3/conflicts/view?copyPath=copy.md',
  '/api/web/g/grp-a3/topics/education',
  // PARCHE-012
  '/api/web/g/grp-a3/secrets',
];

describe('A3 (all endpoints): security matrix', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  for (const endpoint of ALL_ENDPOINTS) {
    it(`401 without session: ${endpoint}`, async () => {
      const res = await ctx.app.inject({ method: 'GET', url: endpoint });
      expect(res.statusCode).toBe(401);
    });

    it(`404 for non-member (user2): ${endpoint}`, async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: endpoint,
        cookies: { parche_session: ctx.session2 },
      });
      expect(res.statusCode).toBe(404);
    });

    it(`404 for nonexistent group: ${endpoint.replace('grp-a3', 'no-such-group')}`, async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: endpoint.replace('grp-a3', 'no-such-group'),
        cookies: { parche_session: ctx.session1 },
      });
      expect(res.statusCode).toBe(404);
    });
  }

  it('404 for removed member (removedAt set)', async () => {
    // Set removedAt to simulate removal
    ctx.app.db
      .update(members)
      .set({ removedAt: new Date().toISOString() })
      .where(and(eq(members.groupId, ctx.group1.groupId), eq(members.userId, ctx.user1.userId)))
      .run();

    // Test every endpoint to ensure removed member gets 404
    for (const endpoint of ALL_ENDPOINTS) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: endpoint,
        cookies: { parche_session: ctx.session1 },
      });
      expect(res.statusCode, `endpoint ${endpoint} should be 404 for removed member`).toBe(404);
    }
  });
});
