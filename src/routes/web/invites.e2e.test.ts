/**
 * AC8: Invite created via web API + vault join (client 1.8.0) → enters with correct role.
 * E2E test using inject() to simulate both the web API and the CLI client request.
 */

import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { groups, members } from '../../db/schema.js';
import {
  cleanupDir,
  makeApp,
  makeConfig,
  makeTempDataDir,
  seedGroupWithDevice,
  seedWebSession,
  seedWebUser,
} from '../../test-helpers.js';

const CSRF_HEADERS = {
  'content-type': 'application/json',
  'x-parche-csrf': '1',
};

describe('AC8 — web invite + vault join e2e', () => {
  let dataDir: string;
  let app: FastifyInstance;
  let groupSlug: string;

  beforeEach(async () => {
    dataDir = await makeTempDataDir();
    app = await makeApp(dataDir, makeConfig(dataDir, { creators: ['owner@example.com'] }));

    const { groupSlug: slug } = await seedGroupWithDevice(app, {
      slug: 'e2e-group',
      ownerEmail: 'owner@example.com',
      ownerName: 'Owner',
    });
    groupSlug = slug;
  });

  afterEach(async () => {
    await app.close();
    await cleanupDir(dataDir);
  });

  it('[mutation-check] creates invite via web and joins with client 1.8.0 body format', async () => {
    const ownerUser = seedWebUser(app, { email: 'owner@example.com', name: 'Owner' });
    const ownerCookie = seedWebSession(app, ownerUser.userId);

    // Create invite via web API for role 'editor'
    const createRes = await app.inject({
      method: 'POST',
      url: `/api/web/groups/${groupSlug}/invites`,
      headers: { ...CSRF_HEADERS, cookie: `parche_session=${ownerCookie}` },
      payload: { role: 'editor', expires: 'never' },
    });
    expect(createRes.statusCode).toBe(200);
    const { code } = createRes.json();
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    // Simulate vault join request (client 1.8.0 exact body format)
    // Based on joinRequestSchema: { code, name, email, deviceLabel? }
    const joinRes = await app.inject({
      method: 'POST',
      url: '/api/join',
      headers: { 'content-type': 'application/json' },
      // No X-Parche-CSRF (CLI endpoint unaffected by CSRF)
      payload: {
        code,
        name: 'New Member',
        email: 'newmember@example.com',
        deviceLabel: 'laptop',
      },
    });
    expect(joinRes.statusCode).toBe(200);

    const joinBody = joinRes.json();
    expect(joinBody.role).toBe('editor');
    expect(joinBody.user.name).toBe('New Member');

    // Verify member row has correct role
    const grp = app.db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.slug, groupSlug))
      .get();

    const { users } = await import('../../db/schema.js');
    const user = app.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'newmember@example.com'))
      .get();

    expect(user).toBeDefined();
    const member = app.db
      .select({ role: members.role })
      .from(members)
      .where(
        and(
          eq(members.groupId, grp?.id as string),
          eq(members.userId, user?.id as string),
          isNull(members.removedAt),
        ),
      )
      .get();

    expect(member?.role).toBe('editor');
  });
});
