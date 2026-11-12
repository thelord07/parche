/**
 * Push hook (S7/N4) tests — PARCHE-012:
 * - A pushed .md with a secret is reported in secret_findings after the hook runs.
 * - When the head later moves to a clean blob, the finding is resolved (never deleted)
 *   and shows up in `pendingRotation`, not `open`.
 * - A tombstone (newHash: null) also resolves open findings for that path.
 * Modelado en src/routes/push-hook-meta.test.ts.
 */
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { secretFindings } from '../db/schema.js';
import {
  cleanupDir,
  makeApp,
  makeTempDataDir,
  seedGroupWithDevice,
  seedMember,
  seedWebSession,
  seedWebUser,
} from '../test-helpers.js';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function putBlob(app: FastifyInstance, body: Buffer, authHeader: string) {
  const hash = sha256(body);
  await app.inject({
    method: 'PUT',
    url: `/api/blob/${hash}`,
    payload: body,
    headers: { 'content-type': 'application/octet-stream', authorization: authHeader },
  });
  return hash;
}

async function waitForOpenFinding(app: FastifyInstance, groupId: string, path: string) {
  for (let i = 0; i < 40; i++) {
    const row = app.db
      .select()
      .from(secretFindings)
      .where(and(eq(secretFindings.groupId, groupId), eq(secretFindings.path, path)))
      .get();
    if (row) return row;
    await new Promise((r) => setTimeout(r, 25));
  }
  return undefined;
}

async function waitForResolved(app: FastifyInstance, groupId: string, path: string) {
  for (let i = 0; i < 40; i++) {
    const row = app.db
      .select()
      .from(secretFindings)
      .where(and(eq(secretFindings.groupId, groupId), eq(secretFindings.path, path)))
      .get();
    if (row?.resolvedAt) return row;
    await new Promise((r) => setTimeout(r, 25));
  }
  return undefined;
}

describe('Push hook: secret-scan reconciliation (PARCHE-012)', () => {
  let dataDir: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    dataDir = await makeTempDataDir();
    app = await makeApp(dataDir, { secretGate: 'report' });
  });

  afterEach(async () => {
    await app.close();
    await cleanupDir(dataDir);
  });

  it('a pushed .md with a secret is reported as an open finding', async () => {
    const { authHeader, groupSlug, groupId } = await seedGroupWithDevice(app, {
      slug: 'push-secret-grp',
    });

    const content = Buffer.from('value: AKIAIOSFODNN7EXAMPLE\n');
    const hash = await putBlob(app, content, authHeader);

    const pushRes = await app.inject({
      method: 'POST',
      url: `/api/g/${groupSlug}/push`,
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: { protocol: 1, changes: [{ path: 'leak.md', baseHash: null, newHash: hash }] },
    });
    expect(pushRes.statusCode).toBe(200);

    const finding = await waitForOpenFinding(app, groupId, 'leak.md');
    expect(finding).toBeDefined();
    expect(finding?.resolvedAt).toBeNull();
    expect(finding?.kind).toBe('aws-access-key');
  }, 10000);

  it('cleaning the head resolves the finding (reconciliation); it appears in pendingRotation, not open', async () => {
    const { authHeader, groupSlug, groupId } = await seedGroupWithDevice(app, {
      slug: 'push-secret-resolve',
    });

    const dirty = Buffer.from('value: AKIAIOSFODNN7EXAMPLE\n');
    const hash1 = await putBlob(app, dirty, authHeader);
    const firstPush = await app.inject({
      method: 'POST',
      url: `/api/g/${groupSlug}/push`,
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: { protocol: 1, changes: [{ path: 'rotate.md', baseHash: null, newHash: hash1 }] },
    });
    expect(firstPush.statusCode).toBe(200);
    await waitForOpenFinding(app, groupId, 'rotate.md');

    const clean = Buffer.from('nada que ver aquí\n');
    const hash2 = await putBlob(app, clean, authHeader);
    const secondPush = await app.inject({
      method: 'POST',
      url: `/api/g/${groupSlug}/push`,
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: { protocol: 1, changes: [{ path: 'rotate.md', baseHash: hash1, newHash: hash2 }] },
    });
    expect(secondPush.statusCode).toBe(200);

    const resolved = await waitForResolved(app, groupId, 'rotate.md');
    expect(resolved).toBeDefined();
    expect(resolved?.resolvedAt).not.toBeNull();

    // Web dashboard — owner sees it in pendingRotation, not in open.
    const owner = seedWebUser(app, { email: 'admin-rotate@example.com' });
    seedMember(app, { groupSlug: 'push-secret-resolve', userId: owner.userId, role: 'admin' });
    const session = seedWebSession(app, owner.userId);

    const secretsRes = await app.inject({
      method: 'GET',
      url: '/api/web/g/push-secret-resolve/secrets',
      cookies: { parche_session: session },
    });
    expect(secretsRes.statusCode).toBe(200);
    const body = secretsRes.json<{
      open: { items: Array<{ path: string }> };
      pendingRotation: { items: Array<{ path: string }> };
    }>();
    expect(body.open.items.some((i) => i.path === 'rotate.md')).toBe(false);
    expect(body.pendingRotation.items.some((i) => i.path === 'rotate.md')).toBe(true);
  }, 10000);

  it('N4: a tombstone (newHash null) resolves open findings for that path', async () => {
    const { authHeader, groupSlug, groupId } = await seedGroupWithDevice(app, {
      slug: 'push-secret-tombstone',
    });

    const dirty = Buffer.from('value: AKIAIOSFODNN7EXAMPLE\n');
    const hash1 = await putBlob(app, dirty, authHeader);
    await app.inject({
      method: 'POST',
      url: `/api/g/${groupSlug}/push`,
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: { protocol: 1, changes: [{ path: 'deleted.md', baseHash: null, newHash: hash1 }] },
    });
    await waitForOpenFinding(app, groupId, 'deleted.md');

    const tombstonePush = await app.inject({
      method: 'POST',
      url: `/api/g/${groupSlug}/push`,
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: { protocol: 1, changes: [{ path: 'deleted.md', baseHash: hash1, newHash: null }] },
    });
    expect(tombstonePush.statusCode).toBe(200);

    const resolved = await waitForResolved(app, groupId, 'deleted.md');
    expect(resolved).toBeDefined();
    expect(resolved?.resolvedAt).not.toBeNull();
  }, 10000);
});
