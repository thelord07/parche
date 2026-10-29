import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGroup, createInvite } from '../admin/commands.js';
import { changes, files } from '../db/schema.js';
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

describe('POST /api/g/:slug/push', () => {
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

  // --------------------------------------------------------------------------
  // AC6: reader gets 403 on /push
  // --------------------------------------------------------------------------
  it('AC6: reader gets 403 on /push', async () => {
    createGroup(app.db, {
      name: 'Push Group',
      slug: 'push-group',
      ownerName: 'Owner',
      ownerEmail: 'owner@push.com',
    });
    const { inviteCode } = createInvite(app.db, { group: 'push-group', role: 'reader' });
    const joinRes = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { code: inviteCode, name: 'Reader', email: 'reader@push.com' },
    });
    const { deviceToken } = joinRes.json() as { deviceToken: string };

    const res = await app.inject({
      method: 'POST',
      url: '/api/g/push-group/push',
      headers: {
        authorization: `Bearer ${deviceToken}`,
        'content-type': 'application/json',
      },
      payload: { protocol: 1, changes: [] },
    });
    expect(res.statusCode).toBe(403);
  });

  // --------------------------------------------------------------------------
  // AC7: push a blob then /changes shows author and device
  // --------------------------------------------------------------------------
  it('AC7: push H1 then /changes shows author and device label', async () => {
    const { authHeader, groupSlug } = await seedGroupWithDevice(app, {
      slug: 'ac7-group',
      ownerName: 'Alice',
      ownerEmail: 'alice@ac7.com',
    });

    const content = Buffer.from('hello world');
    const h1 = await putBlob(app, content, authHeader);

    const pushRes = await app.inject({
      method: 'POST',
      url: `/api/g/${groupSlug}/push`,
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: { protocol: 1, changes: [{ path: 'note.md', baseHash: null, newHash: h1 }] },
    });
    expect(pushRes.statusCode).toBe(200);

    const changesRes = await app.inject({
      method: 'GET',
      url: `/api/g/${groupSlug}/changes`,
      headers: { authorization: authHeader },
    });
    expect(changesRes.statusCode).toBe(200);
    const body = changesRes.json() as {
      changes: Array<{ author: string; device: string; hash: string }>;
    };
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0]?.author).toBe('Alice');
    expect(body.changes[0]?.device).toBe('owner');
    expect(body.changes[0]?.hash).toBe(h1);
  });

  // --------------------------------------------------------------------------
  // AC8: conflict returns conflict result
  // --------------------------------------------------------------------------
  it('AC8: conflict when baseHash does not match head', async () => {
    const { authHeader, groupSlug } = await seedGroupWithDevice(app, { slug: 'ac8-group' });

    const c1 = Buffer.from('version 1');
    const h1 = await putBlob(app, c1, authHeader);

    // Push H1 with base=null
    await app.inject({
      method: 'POST',
      url: `/api/g/${groupSlug}/push`,
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: { protocol: 1, changes: [{ path: 'file.md', baseHash: null, newHash: h1 }] },
    });

    // Try to push with wrong base
    const wrongBase = 'a'.repeat(64);
    const c2 = Buffer.from('version 2');
    const h2 = await putBlob(app, c2, authHeader);

    const res = await app.inject({
      method: 'POST',
      url: `/api/g/${groupSlug}/push`,
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: { protocol: 1, changes: [{ path: 'file.md', baseHash: wrongBase, newHash: h2 }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { results: Array<{ status: string; currentHash: string }> };
    expect(body.results[0]?.status).toBe('conflict');
    expect(body.results[0]?.currentHash).toBe(h1);

    // changes count unchanged (only 1 change from first push)
    const allChanges = app.db.select().from(changes).all();
    expect(allChanges).toHaveLength(1);
  });

  // --------------------------------------------------------------------------
  // AC11: missing blob → 422
  // --------------------------------------------------------------------------
  it('AC11: missing blob → 422 with hashes', async () => {
    const { authHeader, groupSlug } = await seedGroupWithDevice(app, { slug: 'ac9-group' });

    const fakeHash = sha256(Buffer.from('not-uploaded'));

    const res = await app.inject({
      method: 'POST',
      url: `/api/g/${groupSlug}/push`,
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: { protocol: 1, changes: [{ path: 'file.md', baseHash: null, newHash: fakeHash }] },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: string; hashes: string[] };
    expect(body.error).toBe('missing_blobs');
    expect(body.hashes).toContain(fakeHash);

    // No changes inserted
    const allChanges = app.db.select().from(changes).all();
    expect(allChanges).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // AC9: idempotent push (same newHash as head → ok with same seq, no new change)
  // --------------------------------------------------------------------------
  it('AC9: idempotent push returns ok with same seq and does not add change', async () => {
    const { authHeader, groupSlug } = await seedGroupWithDevice(app, { slug: 'ac10-group' });

    const content = Buffer.from('idempotent');
    const h1 = await putBlob(app, content, authHeader);

    // First push
    const res1 = await app.inject({
      method: 'POST',
      url: `/api/g/${groupSlug}/push`,
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: { protocol: 1, changes: [{ path: 'idem.md', baseHash: null, newHash: h1 }] },
    });
    expect(res1.statusCode).toBe(200);
    const seq1 = (res1.json() as { results: Array<{ seq: number }> }).results[0]?.seq;

    // Second push with same newHash
    const res2 = await app.inject({
      method: 'POST',
      url: `/api/g/${groupSlug}/push`,
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: { protocol: 1, changes: [{ path: 'idem.md', baseHash: h1, newHash: h1 }] },
    });
    expect(res2.statusCode).toBe(200);
    const r2 = res2.json() as { results: Array<{ status: string; seq: number }> };
    expect(r2.results[0]?.status).toBe('ok');
    expect(r2.results[0]?.seq).toBe(seq1);

    // Only 1 change total (no duplicate)
    expect(app.db.select().from(changes).all()).toHaveLength(1);
  });

  it('AC9 / gate: null→null on tombstone → ok idempotent (repeated delete)', async () => {
    const { authHeader, groupSlug } = await seedGroupWithDevice(app, { slug: 'ac10b-group' });

    const content = Buffer.from('delete me');
    const h1 = await putBlob(app, content, authHeader);

    // Create then delete
    await app.inject({
      method: 'POST',
      url: `/api/g/${groupSlug}/push`,
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: { protocol: 1, changes: [{ path: 'del.md', baseHash: null, newHash: h1 }] },
    });
    const delRes = await app.inject({
      method: 'POST',
      url: `/api/g/${groupSlug}/push`,
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: { protocol: 1, changes: [{ path: 'del.md', baseHash: h1, newHash: null }] },
    });
    expect(delRes.statusCode).toBe(200);
    const delSeq = (delRes.json() as { results: Array<{ seq: number }> }).results[0]?.seq;

    // Repeated delete of tombstone → ok with head_seq
    const redel = await app.inject({
      method: 'POST',
      url: `/api/g/${groupSlug}/push`,
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: { protocol: 1, changes: [{ path: 'del.md', baseHash: null, newHash: null }] },
    });
    expect(redel.statusCode).toBe(200);
    const r = redel.json() as { results: Array<{ status: string; seq: number }> };
    expect(r.results[0]?.status).toBe('ok');
    expect(r.results[0]?.seq).toBe(delSeq);
  });

  // --------------------------------------------------------------------------
  // AC10: case collision → 409 and rollback
  // --------------------------------------------------------------------------
  it('AC10: case collision → 409 with rollback (no changes added)', async () => {
    const { authHeader, groupSlug } = await seedGroupWithDevice(app, { slug: 'ac11-group' });

    const c1 = Buffer.from('content a');
    const h1 = await putBlob(app, c1, authHeader);
    const c2 = Buffer.from('content b');
    const h2 = await putBlob(app, c2, authHeader);

    // Push Note.md first
    await app.inject({
      method: 'POST',
      url: `/api/g/${groupSlug}/push`,
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: { protocol: 1, changes: [{ path: 'Note.md', baseHash: null, newHash: h1 }] },
    });
    expect(app.db.select().from(changes).all()).toHaveLength(1);

    // Try to push note.md (same key, different path) in a batch with another change
    const c3 = Buffer.from('another');
    const h3 = await putBlob(app, c3, authHeader);
    const res = await app.inject({
      method: 'POST',
      url: `/api/g/${groupSlug}/push`,
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: {
        protocol: 1,
        changes: [
          { path: 'other.md', baseHash: null, newHash: h3 },
          { path: 'note.md', baseHash: null, newHash: h2 }, // collides with Note.md
        ],
      },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string };
    expect(body.error).toBe('case_collision');

    // Rollback: still only 1 change (the original Note.md push)
    expect(app.db.select().from(changes).all()).toHaveLength(1);

    // Rollback: files table also unchanged — only Note.md lives, no other.md row
    const fileRows = app.db.select().from(files).all();
    expect(fileRows).toHaveLength(1);
    expect(fileRows[0]?.path).toBe('Note.md');
  });

  // --------------------------------------------------------------------------
  // AC10: ordered rename (delete + create in same batch, delete first)
  // --------------------------------------------------------------------------
  it('AC10: ordered rename — delete Nota.md then create nota.md in one push succeeds', async () => {
    const { authHeader, groupSlug } = await seedGroupWithDevice(app, { slug: 'ac10r-group' });

    // Seed Nota.md live at H1 via the real API
    const contentH = Buffer.from('nota content');
    const h1 = await putBlob(app, contentH, authHeader);
    await app.inject({
      method: 'POST',
      url: `/api/g/${groupSlug}/push`,
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: { protocol: 1, changes: [{ path: 'Nota.md', baseHash: null, newHash: h1 }] },
    });

    // Upload blob for the new lowercase name
    const contentLower = Buffer.from('nota lowercase content');
    const h = await putBlob(app, contentLower, authHeader);

    // Push delete of Nota.md (baseHash=H1→null) then create nota.md (baseHash=null→H)
    const renameRes = await app.inject({
      method: 'POST',
      url: `/api/g/${groupSlug}/push`,
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: {
        protocol: 1,
        changes: [
          { path: 'Nota.md', baseHash: h1, newHash: null },
          { path: 'nota.md', baseHash: null, newHash: h },
        ],
      },
    });
    expect(renameRes.statusCode).toBe(200);

    const renameBody = renameRes.json() as { results: Array<{ status: string; seq: number }> };
    expect(renameBody.results).toHaveLength(2);
    expect(renameBody.results[0]?.status).toBe('ok');
    expect(renameBody.results[1]?.status).toBe('ok');
    // seqs must be consecutive
    const seqDel = renameBody.results[0]?.seq ?? 0;
    const seqCreate = renameBody.results[1]?.seq ?? 0;
    expect(seqCreate).toBe(seqDel + 1);

    // files: Nota.md is a tombstone, nota.md is live at H
    const fileRows = app.db.select().from(files).all();
    const notaUpper = fileRows.find((f) => f.path === 'Nota.md');
    const notaLower = fileRows.find((f) => f.path === 'nota.md');
    expect(notaUpper).toBeDefined();
    expect(notaUpper?.headHash).toBeNull(); // tombstone
    expect(notaLower).toBeDefined();
    expect(notaLower?.headHash).toBe(h); // live

    // /changes: the delete entry (hash=null) must come before the create entry
    const changesRes = await app.inject({
      method: 'GET',
      url: `/api/g/${groupSlug}/changes`,
      headers: { authorization: authHeader },
    });
    expect(changesRes.statusCode).toBe(200);
    const changesBody = changesRes.json() as {
      changes: Array<{ path: string; hash: string | null; seq: number }>;
    };
    const delEntry = changesBody.changes.find((c) => c.path === 'Nota.md' && c.hash === null);
    const createEntry = changesBody.changes.find((c) => c.path === 'nota.md' && c.hash === h);
    expect(delEntry).toBeDefined();
    expect(createEntry).toBeDefined();
    expect((delEntry?.seq ?? 0) < (createEntry?.seq ?? 0)).toBe(true);
  });

  // --------------------------------------------------------------------------
  // AC12: unsyncable paths → 400
  // --------------------------------------------------------------------------
  it('AC12: .obsidian/workspace.json → 400 (unsyncable)', async () => {
    const { authHeader, groupSlug } = await seedGroupWithDevice(app, { slug: 'ac12a-group' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/g/${groupSlug}/push`,
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: {
        protocol: 1,
        changes: [{ path: '.obsidian/workspace.json', baseHash: null, newHash: null }],
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toBe('unsyncable_path');
  });

  it('AC12: x.exe → 400 (unsyncable)', async () => {
    const { authHeader, groupSlug } = await seedGroupWithDevice(app, { slug: 'ac12b-group' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/g/${groupSlug}/push`,
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: {
        protocol: 1,
        changes: [{ path: 'x.exe', baseHash: null, newHash: null }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  // --------------------------------------------------------------------------
  // Gate decision: null→null on never-existing path → conflict, no DB change
  // --------------------------------------------------------------------------
  it('null→null on never-existing path → conflict {currentHash:null}, files+changes unchanged', async () => {
    const { authHeader, groupSlug } = await seedGroupWithDevice(app, { slug: 'gate-group' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/g/${groupSlug}/push`,
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: {
        protocol: 1,
        changes: [{ path: 'ghost.md', baseHash: null, newHash: null }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { results: Array<{ status: string; currentHash: null }> };
    expect(body.results[0]?.status).toBe('conflict');
    expect(body.results[0]?.currentHash).toBeNull();

    expect(app.db.select().from(changes).all()).toHaveLength(0);
    expect(app.db.select().from(files).all()).toHaveLength(0);
  });
});
