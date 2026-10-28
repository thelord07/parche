import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import * as net from 'node:net';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';
import { cleanupDir, makeApp, makeConfig, makeTempDataDir } from '../test-helpers.js';

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

describe('blob routes', () => {
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

  // ---- AC3: PUT new blob → 201 + sharded file --------------------------------
  describe('AC3: PUT new blob', () => {
    it('returns 201 and creates the sharded file with exact content', async () => {
      const body = Buffer.from('hello parche');
      const hash = sha256(body);

      const res = await app.inject({
        method: 'PUT',
        url: `/api/blob/${hash}`,
        payload: body,
        headers: { 'content-type': 'application/octet-stream' },
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
        headers: { 'content-type': 'application/octet-stream' },
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
        headers: { 'content-type': 'application/octet-stream' },
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
        headers: { 'content-type': 'application/octet-stream' },
      });

      expect(res.statusCode).toBe(400);

      const files = await listFiles(dataDir);
      expect(files).toHaveLength(0);
    });

    it('(b) existing blob + wrong body → 400, stored bytes and mtime unchanged', async () => {
      const correctBody = Buffer.from('correct content');
      const hash = sha256(correctBody);
      const shardedPath = join(dataDir, 'blobs', hash.slice(0, 2), hash.slice(2, 4), hash);

      // Store the correct blob
      const res1 = await app.inject({
        method: 'PUT',
        url: `/api/blob/${hash}`,
        payload: correctBody,
        headers: { 'content-type': 'application/octet-stream' },
      });
      expect(res1.statusCode).toBe(201);

      const statBefore = await stat(shardedPath);
      const contentBefore = await readFile(shardedPath);

      await new Promise((r) => setTimeout(r, 50));

      // Send wrong body for the same hash
      const res2 = await app.inject({
        method: 'PUT',
        url: `/api/blob/${hash}`,
        payload: Buffer.from('wrong body'),
        headers: { 'content-type': 'application/octet-stream' },
      });
      expect(res2.statusCode).toBe(400);

      // Stored file must be unchanged
      const statAfter = await stat(shardedPath);
      expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
      const contentAfter = await readFile(shardedPath);
      expect(contentAfter).toEqual(contentBefore);

      // No extra files
      const files = await listFiles(dataDir);
      expect(files).toHaveLength(1);
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
          headers: { 'content-type': 'application/octet-stream' },
        });
        expect(res.statusCode).toBe(400);
        const files = await listFiles(dataDir);
        expect(files).toHaveLength(0);
      });

      it(`GET ${JSON.stringify(invalidHash)} → 400`, async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/blob/${invalidHash}`,
        });
        expect(res.statusCode).toBe(400);
      });

      it(`HEAD ${JSON.stringify(invalidHash)} → 400`, async () => {
        const res = await app.inject({
          method: 'HEAD',
          url: `/api/blob/${invalidHash}`,
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
      expect(res.statusCode).toBe(404);
      const files = await listFiles(dataDir);
      expect(files).toHaveLength(0);
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

  // ---- AC6: real-HTTP path traversal proof -----------------------------------
  // These tests start an actual TCP server and send UNNORMALISED paths over a raw
  // socket so no HTTP client can normalise the URL before it reaches the server.
  // This is the authoritative proof that AC6 is satisfied over real HTTP.
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
      const files = await listFiles(dataDir);
      expect(files).toHaveLength(0);
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

    beforeEach(async () => {
      smallApp = await makeApp(dataDir, { maxBlobBytes: 10 });
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
        headers: { 'content-type': 'application/octet-stream' },
      });

      expect(res.statusCode).toBe(413);
      const files = await listFiles(dataDir);
      expect(files).toHaveLength(0);
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
        headers: { 'content-type': 'application/octet-stream' },
      });

      const shardedPath = join(dataDir, 'blobs', hash.slice(0, 2), hash.slice(2, 4), hash);
      const statBefore = await stat(shardedPath);

      // Now try with oversized body via small app
      const bigBody = Buffer.from('this is eleven bytes!');
      // Use a different hash to test the existing-blob oversize path
      // Actually we need to test: existing H + oversize body → 413
      // Let's use the same hash with oversized body
      const res = await smallApp.inject({
        method: 'PUT',
        url: `/api/blob/${hash}`,
        payload: bigBody,
        headers: { 'content-type': 'application/octet-stream' },
      });

      expect(res.statusCode).toBe(413);

      const statAfter = await stat(shardedPath);
      expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    });

    // AC7 real-HTTP: send a chunked (no Content-Length) PUT that exceeds maxBlobBytes.
    // Verifies that the server returns 413, completes promptly (socket is destroyed after
    // the response), and leaves no files behind.
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
          { 'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked' },
          body,
        );

        expect(status).toBe(413);
        // No files should remain after the oversize rejection.
        const files = await listFiles(dataDir);
        expect(files).toHaveLength(0);
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
        headers: { 'content-type': 'application/octet-stream' },
      });

      const res = await app.inject({ method: 'GET', url: `/api/blob/${hash}` });
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
        headers: { 'content-type': 'application/octet-stream' },
      });

      const res = await app.inject({ method: 'HEAD', url: `/api/blob/${hash}` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-length']).toBe(String(body.length));
      expect(res.rawPayload.length).toBe(0);
    });

    it('GET absent blob → 404', async () => {
      const hash = 'a'.repeat(64);
      const res = await app.inject({ method: 'GET', url: `/api/blob/${hash}` });
      expect(res.statusCode).toBe(404);
    });

    it('HEAD absent blob → 404', async () => {
      const hash = 'b'.repeat(64);
      const res = await app.inject({ method: 'HEAD', url: `/api/blob/${hash}` });
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
        const headers: Record<string, string> = contentType ? { 'content-type': contentType } : {};

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
        const body = Buffer.from('sin header, por la red');
        const hash = sha256(body);

        const status = await rawHttpStatus(
          '127.0.0.1',
          address.port,
          `PUT /api/blob/${hash} HTTP/1.1`,
          { 'Content-Length': String(body.length) },
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
        headers: { 'content-type': 'application/octet-stream' },
      });
      expect(res.statusCode).toBe(201);
    });

    it('empty body PUT to non-empty-hash → 400', async () => {
      const wrongHash = 'a'.repeat(64); // not sha256 of empty string
      const res = await app.inject({
        method: 'PUT',
        url: `/api/blob/${wrongHash}`,
        payload: Buffer.alloc(0),
        headers: { 'content-type': 'application/octet-stream' },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
