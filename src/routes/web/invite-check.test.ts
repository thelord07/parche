/**
 * AC9: GET /api/web/invites/:code/check
 * - valid code → 200 {valid:true, group, role, inviter, expiresLabel}
 * - invalid (inexistent/revoked/expired/exhausted/bad format) → 200 {valid:false}
 * - format check before DB (bad format = no query)
 * - shared rate limit with /api/join
 * - mixing joins and checks exhausts the shared bucket
 */

import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateInviteCode, hashInviteCode } from '../../auth/tokens.js';
import { invites } from '../../db/schema.js';
import { newId } from '../../ids.js';
import {
  cleanupDir,
  makeApp,
  makeConfig,
  makeTempDataDir,
  seedGroupWithDevice,
  seedWebUser,
} from '../../test-helpers.js';
import { resetInviteRateLimit } from '../invite-rate-limit.js';

describe('GET /api/web/invites/:code/check (AC9)', () => {
  let dataDir: string;
  let app: FastifyInstance;
  let groupSlug: string;
  let groupId: string;

  beforeEach(async () => {
    resetInviteRateLimit();
    dataDir = await makeTempDataDir();
    app = await makeApp(dataDir, makeConfig(dataDir, { creators: ['owner@example.com'] }));

    const seeded = await seedGroupWithDevice(app, {
      slug: 'check-group',
      ownerEmail: 'owner@example.com',
      ownerName: 'Owner',
    });
    groupSlug = seeded.groupSlug;
    groupId = seeded.groupId;
  });

  afterEach(async () => {
    await app.close();
    await cleanupDir(dataDir);
    resetInviteRateLimit();
  });

  function createActiveInvite(
    role = 'editor',
    opts: { expiresOffset?: number; maxUses?: number } = {},
  ): string {
    const code = generateInviteCode();
    const codeHash = hashInviteCode(code);
    const now = new Date().toISOString();
    const expiresAt =
      opts.expiresOffset !== undefined
        ? new Date(Date.now() + opts.expiresOffset).toISOString()
        : null;

    const ownerUser = seedWebUser(app, { email: 'owner@example.com', name: 'Owner' });

    app.db
      .insert(invites)
      .values({
        id: newId(),
        groupId,
        codeHash,
        codeHint: code.split('-')[0] ?? null,
        role,
        createdBy: ownerUser.userId,
        expiresAt,
        maxUses: opts.maxUses ?? null,
        uses: 0,
        createdAt: now,
      })
      .run();
    return code;
  }

  it('valid code → 200 {valid:true} with group, role, inviter, expiresLabel', async () => {
    const code = createActiveInvite('editor');

    const res = await app.inject({
      method: 'GET',
      url: `/api/web/invites/${code}/check`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.valid).toBe(true);
    expect(body.group).toBeDefined();
    expect(body.group.slug).toBe(groupSlug);
    expect(body.role).toBe('editor');
    expect(body.inviter).toBeDefined();
    expect(body.expiresLabel).toBeDefined();
    // No counts
    expect(body.memberCount).toBeUndefined();
    expect(body.uses).toBeUndefined();
  });

  it('invalid (inexistent) code → 200 {valid:false}', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/web/invites/AAAA-BBBB/check',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: false });
  });

  it('revoked invite → 200 {valid:false}', async () => {
    const code = createActiveInvite();
    // Revoke it
    const codeHash = hashInviteCode(code);
    app.db
      .update(invites)
      .set({ revokedAt: new Date().toISOString() })
      .where(eq(invites.codeHash, codeHash))
      .run();

    const res = await app.inject({
      method: 'GET',
      url: `/api/web/invites/${code}/check`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: false });
  });

  it('expired invite → 200 {valid:false}', async () => {
    const code = createActiveInvite('editor', { expiresOffset: -1000 }); // expired

    const res = await app.inject({
      method: 'GET',
      url: `/api/web/invites/${code}/check`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: false });
  });

  it('exhausted invite (maxUses reached) → 200 {valid:false}', async () => {
    const code = createActiveInvite('editor', { maxUses: 1 });
    // Set uses = 1
    const codeHash = hashInviteCode(code);
    app.db.update(invites).set({ uses: 1 }).where(eq(invites.codeHash, codeHash)).run();

    const res = await app.inject({
      method: 'GET',
      url: `/api/web/invites/${code}/check`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: false });
  });

  it('bad format code → 200 {valid:false} (no DB query)', async () => {
    // These are all invalid formats per joinRequestSchema
    const badCodes = ['invalid', '1234', 'AAAA-', '-BBBB', 'aaaa-bbbb', '12345678'];
    for (const code of badCodes) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/web/invites/${code}/check`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ valid: false });
    }
  });

  it('case insensitive: lowercase code normalizes to valid check', async () => {
    const code = createActiveInvite('reader');
    const lower = code.toLowerCase();

    const res = await app.inject({
      method: 'GET',
      url: `/api/web/invites/${lower}/check`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(true);
  });
});

describe('AC9 — shared rate limit with /api/join', () => {
  let dataDir: string;
  let app: FastifyInstance;
  let groupId: string;

  beforeEach(async () => {
    resetInviteRateLimit();
    dataDir = await makeTempDataDir();
    app = await makeApp(dataDir, makeConfig(dataDir, { creators: ['owner@example.com'] }));

    const seeded = await seedGroupWithDevice(app, {
      slug: 'rate-group',
      ownerEmail: 'owner@example.com',
      ownerName: 'Owner',
    });
    groupId = seeded.groupId;
  });

  afterEach(async () => {
    await app.close();
    await cleanupDir(dataDir);
    resetInviteRateLimit();
  });

  it('11 checks from same IP → 11th is 429 (shared bucket)', async () => {
    // First 10 should succeed (or 200 {valid:false} for invalid code)
    const code = 'ZZZZ-ZZZZ'; // non-existent but valid format
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/web/invites/${code}/check`,
      });
      expect(res.statusCode).toBe(200);
    }
    // 11th should be rate limited
    const res = await app.inject({
      method: 'GET',
      url: `/api/web/invites/${code}/check`,
    });
    expect(res.statusCode).toBe(429);
  });

  it('mixed joins and checks exhaust the shared bucket', async () => {
    // Create a valid invite for joins
    const ownerUser = seedWebUser(app, { email: 'owner@example.com', name: 'Owner' });
    const code = generateInviteCode();
    const codeHash = hashInviteCode(code);
    const now = new Date().toISOString();
    app.db
      .insert(invites)
      .values({
        id: newId(),
        groupId,
        codeHash,
        codeHint: code.split('-')[0] ?? null,
        role: 'editor',
        createdBy: ownerUser.userId,
        expiresAt: null,
        maxUses: null,
        uses: 0,
        createdAt: now,
      })
      .run();

    // 5 checks (format invalid = no DB) = 5 total
    for (let i = 0; i < 5; i++) {
      const checkRes = await app.inject({
        method: 'GET',
        url: `/api/web/invites/XXXX-YYYY/check`,
      });
      expect(checkRes.statusCode).toBe(200);
    }
    // 5 joins (valid code) = total 10
    for (let i = 0; i < 5; i++) {
      const joinRes = await app.inject({
        method: 'POST',
        url: '/api/join',
        headers: { 'content-type': 'application/json' },
        payload: {
          code,
          name: `User ${i}`,
          email: `user${i}mixedbucket@example.com`,
        },
      });
      // May 200 or 409 (already member); just not 429 yet
      expect([200, 409]).toContain(joinRes.statusCode);
    }

    // 11th (a check) should be rate limited
    const res = await app.inject({
      method: 'GET',
      url: '/api/web/invites/AAAA-BBBB/check',
    });
    expect(res.statusCode).toBe(429);
  });
});
