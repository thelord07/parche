import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import * as net from 'node:net';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGroup, createInvite, revokeDevice } from '../admin/commands.js';
import { buildServer } from '../server.js';
import {
  cleanupDir,
  makeApp,
  makeConfig,
  makeTempDataDir,
  seedGroupWithDevice,
} from '../test-helpers.js';

// sha256 of the empty string
const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/**
 * Send a raw HTTP/1.1 request over a TCP socket and return the status code.
 * Using net.Socket bypasses any URL normalisation that node:http would apply,
 * so the path is sent verbatim to the server — essential for AC6 path-traversal proofs.
 */
async function rawHttpStatus(
  host: string,
  port: number,
  requestLine: string,
  headers: Record<string, string> = {},
  body?: Buffer,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(port, host);
    let resolved = false;

    socket.once('connect', () => {
      const headerLines = Object.entries({
        Host: `${host}:${port}`,
        Connection: 'close',
        ...headers,
      })
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n');
      const req = `${requestLine}\r\n${headerLines}\r\n\r\n`;
      socket.write(req);
      if (body) socket.write(body);
    });

    let buf = '';
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('binary');
      if (!resolved) {
        const idx = buf.indexOf('\r\n');
        if (idx !== -1) {
          const m = /HTTP\/\d\.\d (\d+)/.exec(buf.slice(0, idx));
          if (m?.[1]) {
            resolved = true;
            const code = Number.parseInt(m[1], 10);
            socket.destroy();
            resolve(code);
          }
        }
      }
    });
    socket.on('error', (err) => {
      if (!resolved) reject(err);
    });
    socket.on('close', () => {
      if (!resolved) reject(new Error('socket closed without response'));
    });
  });
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Recursively list all regular files under dir.
 */
async function listFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await listFiles(full);
      results.push(...nested);
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

/**
 * List only blob storage files (under blobs/ and tmp/) — excludes the SQLite
 * database files (parche.db, parche.db-wal, parche.db-shm) that buildServer
 * creates in dataDir since PARCHE-003.
 */
async function listBlobFiles(dataDir: string): Promise<string[]> {
  const all = await listFiles(dataDir);
  return all.filter((p) => {
    const name = p.slice(p.lastIndexOf('/') + 1);
    return !name.endsWith('.db') && !name.endsWith('.db-wal') && !name.endsWith('.db-shm');
  });
}

describe('blob routes', () => {
  let dataDir: string;
  let app: FastifyInstance;
  let authHeader: string;

  beforeEach(async () => {
    dataDir = await makeTempDataDir();
    app = await makeApp(dataDir);
    const seeded = await seedGroupWithDevice(app);
    authHeader = seeded.authHeader;
  });

  afterEach(async () => {
    await app.close();
    await cleanupDir(dataDir);
  });

  // ---- AC3: PUT new blob → 201 + sharded file --------------------------------
  describe('AC3: PUT new blob', () => {
    it('returns 201 and creates the sharded file with exact content', async () => {
      const body = Buffer.from('hello parche');
      const hash = sha256(body);

      const res = await app.inject({
        method: 'PUT',
        url: `/api/blob/${hash}`,
        payload: body,
        headers: { 'content-type': 'application/octet-stream', authorization: authHeader },
      });

      expect(res.statusCode).toBe(201);

      // Sharded path: <dataDir>/blobs/<h[0:2]>/<h[2:4]>/<hash>
      const shardedPath = join(dataDir, 'blobs', hash.slice(0, 2), hash.slice(2, 4), hash);
      const stored = await readFile(shardedPath);
      expect(stored).toEqual(body);
    });
  });

  // ---- AC4: repeat PUT → 200, mtime unchanged --------------------------------
  describe('AC4: idempotent PUT', () => {
    it('returns 200 and does not change mtime on second PUT', async () => {
      const body = Buffer.from('idempotent content');
      const hash = sha256(body);
      const shardedPath = join(dataDir, 'blobs', hash.slice(0, 2), hash.slice(2, 4), hash);

      // First PUT
      const res1 = await app.inject({
        method: 'PUT',
        url: `/api/blob/${hash}`,
        payload: body,
        headers: { 'content-type': 'application/octet-stream', authorization: authHeader },
      });
      expect(res1.statusCode).toBe(201);

      const statBefore = await stat(shardedPath);
      const mtimeBefore = statBefore.mtimeMs;

      // Brief sleep to ensure mtime would differ if file is rewritten
      await new Promise((r) => setTimeout(r, 50));

      // Second PUT
      const res2 = await app.inject({
        method: 'PUT',
        url: `/api/blob/${hash}`,
        payload: body,
        headers: { 'content-type': 'application/octet-stream', authorization: authHeader },
      });
      expect(res2.statusCode).toBe(200);

      const statAfter = await stat(shardedPath);
      expect(statAfter.mtimeMs).toBe(mtimeBefore);
    });
  });

  // ---- AC5: hash mismatch → 400, no files ------------------------------------
  describe('AC5: hash mismatch', () => {
    it('(a) no prior blob → 400 and zero files under dataDir', async () => {
      const body = Buffer.from('wrong body content');
      const wrongHash = sha256(Buffer.from('different content'));

      const res = await app.inject({
        method: 'PUT',
        url: `/api/blob/${wrongHash}`,
        payload: body,
        headers: { 'content-type': 'application/octet-stream', authorization: authHeader },
      });

      expect(res.statusCode).toBe(400);

      const files = await listBlobFiles(dataDir);
      expect(files).toHaveLength(0);
    });

    it('(b) existing blob + wrong body → 400, stored bytes and mtime unchanged', async () => {
      const correctBody = Buffer.from('correct content');
      const hash = sha256(correctBody);
      const shardedPath = join(dataDir, 'blobs', hash.slice(0, 2), hash.slice(2, 4), hash);

      // Store the correct blob first
      await app.inject({
        method: 'PUT',
        url: `/api/blob/${hash}`,
        payload: correctBody,
        headers: { 'content-type': 'application/octet-stream', authorization: authHeader },
      });

      const contentBefore = await readFile(shardedPath);
      const statBefore = await stat(shardedPath);

      // Try to PUT wrong body under same hash
      const res2 = await app.inject({
        method: 'PUT',
        url: `/api/blob/${hash}`,
        payload: Buffer.from('wrong body'),
        headers: { 'content-type': 'application/octet-stream', authorization: authHeader },
      });
      expect(res2.statusCode).toBe(400);

      // Stored file must be unchanged
      const statAfter = await stat(shardedPath);
      expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
      const contentAfter = await readFile(shardedPath);
      expect(contentAfter).toEqual(contentBefore);

      // No extra files
      const blobFiles = await listBlobFiles(dataDir);
      expect(blobFiles).toHaveLength(1);
    });
  });

  // ---- AC5 (auth): 401 on blob routes for missing/invalid/revoked token -------
  describe('AC5: 401 on blob routes without valid auth', () => {
    it('PUT without auth → 401', async () => {
      const body = Buffer.from('no auth');
      const hash = sha256(body);
      const res = await app.inject({
        method: 'PUT',
        url: `/api/blob/${hash}`,
        payload: body,
        headers: { 'content-type': 'application/octet-stream' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('GET without auth → 401', async () => {
      const hash = 'a'.repeat(64);
      const res = await app.inject({ method: 'GET', url: `/api/blob/${hash}` });
      expect(res.statusCode).toBe(401);
    });

    it('HEAD without auth → 401', async () => {
      const hash = 'b'.repeat(64);
      const res = await app.inject({ method: 'HEAD', url: `/api/blob/${hash}` });
      expect(res.statusCode).toBe(401);
    });

    it('PUT with invalid token → 401', async () => {
      const body = Buffer.from('bad token');
      const hash = sha256(body);
      const res = await app.inject({
        method: 'PUT',
        url: `/api/blob/${hash}`,
        payload: body,
        headers: {
          'content-type': 'application/octet-stream',
          authorization: 'Bearer pch_invalidtoken',
        },
      });
      expect(res.statusCode).toBe(401);
    });

    it('AC5: revoked device token → 401 on GET /api/blob/:hash', async () => {
      // Seed a group with a second device we can revoke
      const seededB = await seedGroupWithDevice(app, { slug: 'ac5-revoke-blob' });
      const hash = 'a'.repeat(64);

      // Confirm the token works before revocation
      const preRes = await app.inject({
        method: 'GET',
        url: `/api/blob/${hash}`,
        headers: { authorization: seededB.authHeader },
      });
      // 404 is fine — it means auth passed but blob isn't there
      expect([200, 404]).toContain(preRes.statusCode);

      // Revoke the device
      revokeDevice(app.db, { deviceId: seededB.deviceId });

      // Now the same token must yield 401
      const postRes = await app.inject({
        method: 'GET',
        url: `/api/blob/${hash}`,
        headers: { authorization: seededB.authHeader },
      });
      expect(postRes.statusCode).toBe(401);
    });
  });

  // ---- AC13: blob from group A, GET from group B → 404 -----------------------
  describe('AC13: cross-group blob scoping', () => {
    it('blob uploaded by group A is not accessible by group B (GET → 404)', async () => {
      // authHeader is from group A (seeded in beforeEach)
      const body = Buffer.from('group a blob');
      const hash = sha256(body);

      await app.inject({
        method: 'PUT',
        url: `/api/blob/${hash}`,
        payload: body,
        headers: { 'content-type': 'application/octet-stream', authorization: authHeader },
      });

      // Seed group B and get its token
      const seededB = await seedGroupWithDevice(app, { slug: 'group-b-ac13' });

      const res = await app.inject({
        method: 'GET',
        url: `/api/blob/${hash}`,
        headers: { authorization: seededB.authHeader },
      });
      expect(res.statusCode).toBe(404);
    });

    it('blob uploaded by group A is not accessible by group B (HEAD → 404)', async () => {
      const body = Buffer.from('group a blob head');
      const hash = sha256(body);

      await app.inject({
        method: 'PUT',
        url: `/api/blob/${hash}`,
        payload: body,
        headers: { 'content-type': 'application/octet-stream', authorization: authHeader },
      });

      const seededB = await seedGroupWithDevice(app, { slug: 'group-b-ac13-head' });

      const res = await app.inject({
        method: 'HEAD',
        url: `/api/blob/${hash}`,
        headers: { authorization: seededB.authHeader },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ---- AC14: concurrent PUTs (HTTP) — 4 concurrent PUTs → 1 x 201, 3 x 200 --
  describe('AC14: concurrent PUTs via HTTP', () => {
    it('4 concurrent PUTs → exactly 1 x 201 and 3 x 200', { timeout: 10000 }, async () => {
      const realApp = await buildServer(makeConfig(dataDir));
      try {
        await realApp.listen({ port: 0, host: '127.0.0.1' });
        const addr = realApp.server.address();
        if (!addr || typeof addr === 'string') throw new Error('no address');
        const port = addr.port;

        // Seed a device on the real server's DB
        createGroup(realApp.db, {
          name: 'Concurrent Group',
          slug: 'concurrent-group',
          ownerName: 'Owner',
          ownerEmail: 'owner@concurrent.com',
        });
        const { inviteCode } = createInvite(realApp.db, {
          group: 'concurrent-group',
          role: 'editor',
        });
        const joinRes = await realApp.inject({
          method: 'POST',
          url: '/api/join',
          payload: { code: inviteCode, name: 'Editor', email: 'editor@concurrent.com' },
        });
        const { deviceToken } = joinRes.json() as { deviceToken: string };

        const body = Buffer.from('concurrent content');
        const hash = sha256(body);

        // 4 concurrent PUTs
        const statuses = await Promise.all(
          Array.from({ length: 4 }, () =>
            rawHttpStatus(
              '127.0.0.1',
              port,
              `PUT /api/blob/${hash} HTTP/1.1`,
              {
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(body.length),
                Authorization: `Bearer ${deviceToken}`,
              },
              body,
            ),
          ),
        );

        const created = statuses.filter((s) => s === 201).length;
        const ok = statuses.filter((s) => s === 200).length;
        expect(created).toBe(1);
        expect(ok).toBe(3);
      } finally {
        await realApp.close();
      }
    });
  });

  // ---- AC6: invalid hash → 400, FS untouched ---------------------------------
  describe('AC6: invalid hash validation matrix', () => {
    // These hashes reach the route and get rejected by isValidHash → 400.
    const INVALID_HASHES_400 = [
      // uppercase
      'A'.repeat(64),
      // 63 chars
      'a'.repeat(63),
      // 65 chars
      'a'.repeat(65),
      // non-hex
      'z'.repeat(64),
      // path traversal percent-encoded — %2F is not a real slash, so the router
      // matches /api/blob/:hash with hash='..%2Fetc%2Fpasswd' (or decoded '../etc/passwd'),
      // which fails isValidHash → 400.
      '..%2Fetc%2Fpasswd',
    ];

    for (const invalidHash of INVALID_HASHES_400) {
      it(`PUT ${JSON.stringify(invalidHash)} → 400, FS untouched`, async () => {
        const res = await app.inject({
          method: 'PUT',
          url: `/api/blob/${invalidHash}`,
          payload: Buffer.from('some body'),
          headers: { 'content-type': 'application/octet-stream', authorization: authHeader },
        });
        expect(res.statusCode).toBe(400);
        const blobFiles = await listBlobFiles(dataDir);
        expect(blobFiles).toHaveLength(0);
      });

      it(`GET ${JSON.stringify(invalidHash)} → 400`, async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/blob/${invalidHash}`,
          headers: { authorization: authHeader },
        });
        expect(res.statusCode).toBe(400);
      });

      it(`HEAD ${JSON.stringify(invalidHash)} → 400`, async () => {
        const res = await app.inject({
          method: 'HEAD',
          url: `/api/blob/${invalidHash}`,
          headers: { authorization: authHeader },
        });
        expect(res.statusCode).toBe(400);
      });
    }

    // Raw path traversal '../etc/passwd' — light-my-request normalises
    // /api/blob/../etc/passwd → /api/etc/passwd before creating the fake
    // IncomingMessage, so request.raw.url is already normalised in inject() mode
    // and neither URL check in the not-found handler matches /api/blob/ → 404.
    // In production (real HTTP), request.raw.url is the verbatim TCP stream bytes
    // (/api/blob/../etc/passwd), which DOES start with /api/blob/ → 400.
    // The real-HTTP tests below are the authoritative AC6 proof.
    it('raw path traversal ../etc/passwd → 404 in inject() (URL normalised by light-my-request) and FS untouched (PUT)', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/blob/../etc/passwd',
        payload: Buffer.from('some body'),
        headers: { 'content-type': 'application/octet-stream' },
      });
      // inject() normalises the URL; the real-HTTP raw-socket test below asserts 400.
      // The traversal not-found handler returns 400 without auth (note: no auth here).
      expect(res.statusCode).toBe(404);
      const blobFiles = await listBlobFiles(dataDir);
      expect(blobFiles).toHaveLength(0);
    });

    it('raw path traversal ../etc/passwd → 404 in inject() (GET)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/blob/../etc/passwd',
      });
      // inject() normalises the URL; the real-HTTP raw-socket test below asserts 400.
      expect(res.statusCode).toBe(404);
    });

    it('raw path traversal ../etc/passwd → 404 in inject() (HEAD)', async () => {
      const res = await app.inject({
        method: 'HEAD',
        url: '/api/blob/../etc/passwd',
      });
      // inject() normalises the URL; the real-HTTP raw-socket test below asserts 400.
      expect(res.statusCode).toBe(404);
    });
  });

  // ---- AC6: real-HTTP path-traversal proof -----------------------------------
  // These tests start an actual TCP server and send UNNORMALISED paths over a raw
  // socket so no HTTP client can normalise the URL before it reaches the server.
  // This is the authoritative proof that AC6 is satisfied over real HTTP.
  // Path traversal hits the not-found handler which returns 400 WITHOUT auth.
  describe('AC6: real-HTTP path-traversal proof', () => {
    let realApp: FastifyInstance;
    let port: number;

    beforeEach(async () => {
      realApp = await buildServer(makeConfig(dataDir));
      await realApp.listen({ port: 0, host: '127.0.0.1' });
      const addr = realApp.server.address();
      if (!addr || typeof addr === 'string') throw new Error('unexpected address');
      port = addr.port;
    });

    afterEach(async () => {
      await realApp.close();
    });

    it('PUT /api/blob/../etc/passwd over real HTTP → 400 and no files created', async () => {
      const status = await rawHttpStatus(
        '127.0.0.1',
        port,
        'PUT /api/blob/../etc/passwd HTTP/1.1',
        { 'Content-Type': 'application/octet-stream', 'Content-Length': '9' },
        Buffer.from('some body'),
      );
      expect(status).toBe(400);
      const blobFiles = await listBlobFiles(dataDir);
      expect(blobFiles).toHaveLength(0);
    });

    it('GET /api/blob/../etc/passwd over real HTTP → 400', async () => {
      const status = await rawHttpStatus('127.0.0.1', port, 'GET /api/blob/../etc/passwd HTTP/1.1');
      expect(status).toBe(400);
    });

    it('HEAD /api/blob/../etc/passwd over real HTTP → 400', async () => {
      const status = await rawHttpStatus(
        '127.0.0.1',
        port,
        'HEAD /api/blob/../etc/passwd HTTP/1.1',
      );
      expect(status).toBe(400);
    });
  });

  // ---- AC7: oversize → 413, no file ------------------------------------------
  describe('AC7: blob too large', () => {
    let smallApp: FastifyInstance;
    let smallAuthHeader: string;

    beforeEach(async () => {
      smallApp = await makeApp(dataDir, { maxBlobBytes: 10 });
      const seeded = await seedGroupWithDevice(smallApp, { slug: 'small-app-group' });
      smallAuthHeader = seeded.authHeader;
    });

    afterEach(async () => {
      await smallApp.close();
    });

    it('returns 413 when body exceeds maxBlobBytes and no file is created', async () => {
      const body = Buffer.from('this is eleven bytes!'); // > 10 bytes
      const hash = sha256(body);

      const res = await smallApp.inject({
        method: 'PUT',
        url: `/api/blob/${hash}`,
        payload: body,
        headers: { 'content-type': 'application/octet-stream', authorization: smallAuthHeader },
      });

      expect(res.statusCode).toBe(413);
      const blobFiles = await listBlobFiles(dataDir);
      expect(blobFiles).toHaveLength(0);
    });

    it('existing blob + oversize body → 413, stored blob unchanged', async () => {
      // Store a small blob first
      const correctBody = Buffer.from('hi'); // <= 10 bytes
      const hash = sha256(correctBody);

      // Use normal-size app to store the blob
      await app.inject({
        method: 'PUT',
        url: `/api/blob/${hash}`,
        payload: correctBody,
        headers: { 'content-type': 'application/octet-stream', authorization: authHeader },
      });

      const shardedPath = join(dataDir, 'blobs', hash.slice(0, 2), hash.slice(2, 4), hash);
      const statBefore = await stat(shardedPath);

      // Now try with oversized body via small app (using its own auth)
      const bigBody = Buffer.from('this is eleven bytes!');
      const res = await smallApp.inject({
        method: 'PUT',
        url: `/api/blob/${hash}`,
        payload: bigBody,
        headers: { 'content-type': 'application/octet-stream', authorization: smallAuthHeader },
      });

      expect(res.statusCode).toBe(413);

      const statAfter = await stat(shardedPath);
      expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    });

    // AC7 real-HTTP: send a chunked (no Content-Length) PUT that exceeds maxBlobBytes.
    it('real-HTTP: chunked PUT exceeding maxBlobBytes → 413, completes promptly, no files', {
      timeout: 5000,
    }, async () => {
      // Start a real TCP server with a 10-byte limit.
      const realSmallApp = await buildServer(makeConfig(dataDir, { maxBlobBytes: 10 }));
      try {
        await realSmallApp.listen({ port: 0, host: '127.0.0.1' });
        const addr = realSmallApp.server.address();
        if (!addr || typeof addr === 'string') throw new Error('unexpected address');
        const realPort = addr.port;

        // Create owner directly in DB — can't use HTTP join because bodyLimit:10 would reject the JSON body
        const { deviceToken } = createGroup(realSmallApp.db, {
          name: 'Small Real Group',
          slug: 'small-real-group',
          ownerName: 'Owner',
          ownerEmail: 'owner@small.com',
        });

        // Build a chunked body of 21 bytes — well over the 10-byte limit.
        const chunkData = Buffer.from('this is eleven bytes!'); // 21 bytes
        const hexLen = chunkData.length.toString(16);
        // Transfer-Encoding: chunked, no Content-Length.
        const body = Buffer.from(
          `${hexLen}\r\n${chunkData.toString('binary')}\r\n0\r\n\r\n`,
          'binary',
        );
        const hash = sha256(chunkData);

        const status = await rawHttpStatus(
          '127.0.0.1',
          realPort,
          `PUT /api/blob/${hash} HTTP/1.1`,
          {
            'Content-Type': 'application/octet-stream',
            'Transfer-Encoding': 'chunked',
            Authorization: `Bearer ${deviceToken}`,
          },
          body,
        );

        expect(status).toBe(413);
        // No files should remain after the oversize rejection.
        const blobFiles = await listBlobFiles(dataDir);
        expect(blobFiles).toHaveLength(0);
      } finally {
        await realSmallApp.close();
      }
    });
  });

  // ---- AC8: GET/HEAD 200 or 404 ----------------------------------------------
  describe('AC8: GET and HEAD', () => {
    it('GET returns 200 with identical bytes and content-type application/octet-stream', async () => {
      const body = Buffer.from('get me back');
      const hash = sha256(body);

      await app.inject({
        method: 'PUT',
        url: `/api/blob/${hash}`,
        payload: body,
        headers: { 'content-type': 'application/octet-stream', authorization: authHeader },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/blob/${hash}`,
        headers: { authorization: authHeader },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/octet-stream/);
      expect(res.rawPayload).toEqual(body);
    });

    it('HEAD returns 200 with content-length and empty body', async () => {
      const body = Buffer.from('head me');
      const hash = sha256(body);

      await app.inject({
        method: 'PUT',
        url: `/api/blob/${hash}`,
        payload: body,
        headers: { 'content-type': 'application/octet-stream', authorization: authHeader },
      });

      const res = await app.inject({
        method: 'HEAD',
        url: `/api/blob/${hash}`,
        headers: { authorization: authHeader },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-length']).toBe(String(body.length));
      expect(res.rawPayload.length).toBe(0);
    });

    it('GET absent blob → 404', async () => {
      const hash = 'a'.repeat(64);
      const res = await app.inject({
        method: 'GET',
        url: `/api/blob/${hash}`,
        headers: { authorization: authHeader },
      });
      expect(res.statusCode).toBe(404);
    });

    it('HEAD absent blob → 404', async () => {
      const hash = 'b'.repeat(64);
      const res = await app.inject({
        method: 'HEAD',
        url: `/api/blob/${hash}`,
        headers: { authorization: authHeader },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ---- Empty-body edge -------------------------------------------------------
  // ---- PUT is Content-Type agnostic: every body arrives as a raw stream --------
  describe('PUT ignores Content-Type', () => {
    const cases: Array<{ name: string; body: Buffer; contentType?: string }> = [
      { name: 'text/plain', body: Buffer.from('hola parche'), contentType: 'text/plain' },
      {
        name: 'application/json (valid JSON)',
        body: Buffer.from('{"a":1,"b":[true,null]}'),
        contentType: 'application/json',
      },
      {
        name: 'application/json (invalid JSON)',
        body: Buffer.from('{not json'),
        contentType: 'application/json',
      },
      { name: 'no Content-Type header', body: Buffer.from('sin header') },
    ];

    for (const { name, body, contentType } of cases) {
      it(`${name} → 201 and stores the exact bytes`, async () => {
        const hash = sha256(body);
        const headers: Record<string, string> = { authorization: authHeader };
        if (contentType) headers['content-type'] = contentType;

        let seenContentType: string | undefined = 'not captured';
        app.addHook('onRequest', async (request) => {
          seenContentType = request.headers['content-type'];
        });

        const res = await app.inject({
          method: 'PUT',
          url: `/api/blob/${hash}`,
          payload: body,
          headers,
        });

        expect(seenContentType).toBe(contentType);
        expect(res.statusCode).toBe(201);
        const shardedPath = join(dataDir, 'blobs', hash.slice(0, 2), hash.slice(2, 4), hash);
        expect(await readFile(shardedPath)).toEqual(body);
      });
    }

    it('no Content-Type header over real HTTP → 201', async () => {
      const realDir = await makeTempDataDir();
      const realApp = await buildServer(makeConfig(realDir));
      try {
        await realApp.listen({ port: 0, host: '127.0.0.1' });
        const address = realApp.server.address();
        if (address === null || typeof address === 'string') throw new Error('no port');

        // Seed auth
        createGroup(realApp.db, {
          name: 'Content Type Group',
          slug: 'ct-group',
          ownerName: 'Owner',
          ownerEmail: 'owner@ct.com',
        });
        const { inviteCode } = createInvite(realApp.db, { group: 'ct-group', role: 'editor' });
        const joinRes = await realApp.inject({
          method: 'POST',
          url: '/api/join',
          payload: { code: inviteCode, name: 'Editor', email: 'editor@ct.com' },
        });
        const { deviceToken } = joinRes.json() as { deviceToken: string };

        const body = Buffer.from('sin header, por la red');
        const hash = sha256(body);

        const status = await rawHttpStatus(
          '127.0.0.1',
          address.port,
          `PUT /api/blob/${hash} HTTP/1.1`,
          {
            'Content-Length': String(body.length),
            Authorization: `Bearer ${deviceToken}`,
          },
          body,
        );

        expect(status).toBe(201);
        const shardedPath = join(realDir, 'blobs', hash.slice(0, 2), hash.slice(2, 4), hash);
        expect(await readFile(shardedPath)).toEqual(body);
      } finally {
        await realApp.close();
        await cleanupDir(realDir);
      }
    });
  });

  describe('empty body edge cases', () => {
    it('empty body PUT to EMPTY_HASH → 201', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/blob/${EMPTY_HASH}`,
        payload: Buffer.alloc(0),
        headers: { 'content-type': 'application/octet-stream', authorization: authHeader },
      });
      expect(res.statusCode).toBe(201);
    });

    it('empty body PUT to non-empty-hash → 400', async () => {
      const wrongHash = 'a'.repeat(64); // not sha256 of empty string
      const res = await app.inject({
        method: 'PUT',
        url: `/api/blob/${wrongHash}`,
        payload: Buffer.alloc(0),
        headers: { 'content-type': 'application/octet-stream', authorization: authHeader },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
