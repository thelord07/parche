/**
 * AC5: CSRF protection on /api/web/* mutations.
 * - Without X-Parche-CSRF header → 403
 * - Without application/json content-type → 403
 * - With both correct → passes
 * - Mutation-check: /api/join NOT affected
 */

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupDir,
  makeApp,
  makeConfig,
  makeTempDataDir,
  seedGroupWithDevice,
  seedWebSession,
  seedWebUser,
} from '../../test-helpers.js';

describe('CSRF protection (AC5)', () => {
  let dataDir: string;
  let app: FastifyInstance;
  let sessionCookie: string;

  beforeEach(async () => {
    dataDir = await makeTempDataDir();
    app = await makeApp(dataDir, makeConfig(dataDir, { creators: ['creator@example.com'] }));
    const { userId } = seedWebUser(app, { email: 'creator@example.com' });
    sessionCookie = seedWebSession(app, userId);
  });

  afterEach(async () => {
    await app.close();
    await cleanupDir(dataDir);
  });

  it('POST /api/web/groups without X-Parche-CSRF → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/web/groups',
      headers: {
        'content-type': 'application/json',
        cookie: `parche_session=${sessionCookie}`,
      },
      payload: { name: 'Test', slug: 'test-slug' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST /api/web/groups with X-Parche-CSRF but text/plain → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/web/groups',
      headers: {
        'content-type': 'text/plain',
        'x-parche-csrf': '1',
        cookie: `parche_session=${sessionCookie}`,
      },
      body: 'name=Test&slug=test',
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST /api/web/groups with both headers → not 403 (passes CSRF)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/web/groups',
      headers: {
        'content-type': 'application/json',
        'x-parche-csrf': '1',
        cookie: `parche_session=${sessionCookie}`,
      },
      payload: { name: 'Test Group', slug: 'test-group-csrf' },
    });
    // Should not be 403 (may be 200 or other error but not CSRF)
    expect(res.statusCode).not.toBe(403);
  });

  it('[mutation-check] POST /api/join works WITHOUT X-Parche-CSRF (CLI endpoint unaffected)', async () => {
    // Seed a group with an invite
    const { groupSlug } = await seedGroupWithDevice(app, { slug: 'cli-group' });

    // Create invite via admin command
    const { createInvite } = await import('../../admin/commands.js');
    const { inviteCode } = createInvite(app.db, {
      group: groupSlug,
      role: 'editor',
    });

    // POST /api/join without CSRF header — should succeed (200)
    const res = await app.inject({
      method: 'POST',
      url: '/api/join',
      headers: { 'content-type': 'application/json' },
      // No x-parche-csrf header
      payload: {
        code: inviteCode,
        name: 'CLI User',
        email: 'cliuser@example.com',
      },
    });
    expect(res.statusCode).toBe(200);
  });
});
