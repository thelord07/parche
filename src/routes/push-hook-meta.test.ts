/**
 * Push hook (S5) tests:
 * - A push of a .md file triggers file_meta update (updateFileMetaFromBlob)
 * - A parse failure / storage error does NOT fail the push (only warns)
 * - Non-.md files do not trigger meta extraction
 */

import { createHash } from 'node:crypto';
import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileMeta } from '../db/schema.js';
import { blobPath } from '../storage/blob-path.js';
import { cleanupDir, makeApp, makeTempDataDir, seedGroupWithDevice } from '../test-helpers.js';

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

describe('Push hook: file_meta update after push', () => {
  let dataDir: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    dataDir = await makeTempDataDir();
    app = await makeApp(dataDir);
  });

  afterEach(async () => {
    await app.close();
    await cleanupDir(dataDir);
  });

  it('a .md push updates file_meta (title extracted)', async () => {
    const { authHeader, groupSlug, groupId } = await seedGroupWithDevice(app, {
      slug: 'push-hook-grp',
    });

    const content = Buffer.from('# My Note Title\n\nContent here.\n');
    const hash = await putBlob(app, content, authHeader);

    const pushRes = await app.inject({
      method: 'POST',
      url: `/api/g/${groupSlug}/push`,
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: { protocol: 1, changes: [{ path: 'note.md', baseHash: null, newHash: hash }] },
    });
    expect(pushRes.statusCode).toBe(200);
    const body = pushRes.json<{ results: Array<{ status: string }> }>();
    expect(body.results[0]?.status).toBe('ok');

    // Give background hook time to run
    await new Promise((resolve) => setTimeout(resolve, 100));

    const meta = app.db
      .select({ title: fileMeta.title })
      .from(fileMeta)
      .where(and(eq(fileMeta.groupId, groupId), eq(fileMeta.path, 'note.md')))
      .get();

    expect(meta?.title).toBe('My Note Title');
  }, 10000);

  it('a .md push with storage.get failure does NOT fail the push, and logs a warning', async () => {
    const { authHeader, groupSlug } = await seedGroupWithDevice(app, {
      slug: 'push-hook-err',
    });

    // Upload blob so blob_refs exist (proof-of-possession passes), then remove
    // the actual file from disk so storage.get throws when the meta hook runs.
    const content = Buffer.from('# Error Note\n\nWill fail extraction.\n');
    const hash = await putBlob(app, content, authHeader);

    // Replace the blob file with a directory so that storage.get(hash) returns
    // a ReadStream that fails with EISDIR when read — triggering the warning logger.
    // (Deleting alone would make storage.get return null with no log entry.)
    const blobsDir = join(dataDir, 'blobs');
    const blobFile = blobPath(blobsDir, hash);
    await unlink(blobFile);
    await mkdir(blobFile); // same path, now a directory

    // Spy on app.log.warn to verify the warning is emitted
    const warnSpy = vi.spyOn(app.log, 'warn');

    // The push itself must succeed regardless of what happens in the meta hook
    const pushRes = await app.inject({
      method: 'POST',
      url: `/api/g/${groupSlug}/push`,
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: { protocol: 1, changes: [{ path: 'error-note.md', baseHash: null, newHash: hash }] },
    });
    expect(pushRes.statusCode).toBe(200);
    const body = pushRes.json<{ results: Array<{ status: string }> }>();
    expect(body.results[0]?.status).toBe('ok');

    // Give the background meta hook time to run and log
    await new Promise((resolve) => setTimeout(resolve, 200));

    // A warning should have been emitted by updateFileMetaFromBlob
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('file-meta'),
      expect.objectContaining({ path: 'error-note.md' }),
    );

    vi.restoreAllMocks();
  }, 10000);

  it('a non-.md push does not create file_meta', async () => {
    const { authHeader, groupSlug, groupId } = await seedGroupWithDevice(app, {
      slug: 'push-hook-bin',
    });

    const content = Buffer.from('\x89PNG\r\n\x1a\n'); // PNG magic bytes
    const hash = await putBlob(app, content, authHeader);

    const pushRes = await app.inject({
      method: 'POST',
      url: `/api/g/${groupSlug}/push`,
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: { protocol: 1, changes: [{ path: 'image.png', baseHash: null, newHash: hash }] },
    });
    expect(pushRes.statusCode).toBe(200);
    const body = pushRes.json<{ results: Array<{ status: string }> }>();
    expect(body.results[0]?.status).toBe('ok');

    await new Promise((resolve) => setTimeout(resolve, 100));

    const metaCount = app.db
      .select()
      .from(fileMeta)
      .where(eq(fileMeta.groupId, groupId))
      .all().length;

    expect(metaCount).toBe(0);
  }, 10000);
});
