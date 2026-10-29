/**
 * AC5 — trustProxy integration tests (vitest + inject, no Docker required)
 *
 * The /api/join endpoint is rate-limited at 10 req/min per IP.
 * With trustProxy enabled, Fastify derives request.ip from X-Forwarded-For.
 * With trustProxy disabled (default), X-Forwarded-For is ignored and all
 * requests collapse to the socket IP (127.0.0.1 in inject mode).
 *
 * Case A: with trust, 11 requests with 11 *different* XFF IPs → none get 429
 * Case B: with trust, 11 requests with the *same*  XFF IP      → 11th gets 429
 * Case C: without trust, 11 requests with different XFF IPs    → 11th gets 429
 *         (because XFF is ignored, all use the socket IP)
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupDir, makeApp, makeTempDataDir } from '../test-helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Send a POST /api/join with an optional X-Forwarded-For header.
 * We don't need a valid body — rate-limit hooks count every incoming request
 * regardless of body validity, so a 400 body still increments the counter.
 */
async function postJoin(
  app: FastifyInstance,
  xff: string | undefined,
): Promise<{ status: number }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (xff !== undefined) {
    headers['x-forwarded-for'] = xff;
  }
  const res = await app.inject({
    method: 'POST',
    url: '/api/join',
    headers,
    payload: JSON.stringify({}),
  });
  return { status: res.statusCode };
}

// ---------------------------------------------------------------------------
// Case A — trust proxy ON, 11 *different* source IPs → none 429
// ---------------------------------------------------------------------------

describe('Case A: trust proxy ON, distinct XFF IPs → no 429', () => {
  let dataDir: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    dataDir = await makeTempDataDir();
    // Trust the inject socket address (127.0.0.1) so Fastify reads XFF
    app = await makeApp(dataDir, { trustProxy: '127.0.0.1' });
  });

  afterEach(async () => {
    await app.close();
    await cleanupDir(dataDir);
  });

  it('11 requests each with a different XFF IP all return non-429', async () => {
    const results: number[] = [];
    for (let i = 0; i < 11; i++) {
      const xff = `203.0.113.${i + 1}`; // unique per iteration
      const { status } = await postJoin(app, xff);
      results.push(status);
    }
    expect(results.every((s) => s !== 429)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Case B — trust proxy ON, same XFF IP 11 times → 11th gets 429
// ---------------------------------------------------------------------------

describe('Case B: trust proxy ON, same XFF IP → 11th gets 429', () => {
  let dataDir: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    dataDir = await makeTempDataDir();
    app = await makeApp(dataDir, { trustProxy: '127.0.0.1' });
  });

  afterEach(async () => {
    await app.close();
    await cleanupDir(dataDir);
  });

  it('first 10 requests return non-429; 11th returns 429', async () => {
    const sameXff = '203.0.113.99';
    for (let i = 0; i < 10; i++) {
      const { status } = await postJoin(app, sameXff);
      expect(status).not.toBe(429);
    }
    const { status: eleventh } = await postJoin(app, sameXff);
    expect(eleventh).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// Case C — trust proxy OFF, 11 different XFF IPs → 11th gets 429
//           (XFF ignored; all requests share the socket IP)
// ---------------------------------------------------------------------------

describe('Case C: trust proxy OFF, different XFF IPs are ignored → 11th gets 429', () => {
  let dataDir: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    dataDir = await makeTempDataDir();
    // Default: trustProxy = '' (disabled)
    app = await makeApp(dataDir);
  });

  afterEach(async () => {
    await app.close();
    await cleanupDir(dataDir);
  });

  it('first 10 requests return non-429; 11th returns 429 despite different XFF values', async () => {
    for (let i = 0; i < 10; i++) {
      const xff = `203.0.113.${i + 1}`; // different each time, but ignored
      const { status } = await postJoin(app, xff);
      expect(status).not.toBe(429);
    }
    const { status: eleventh } = await postJoin(app, '203.0.113.200');
    expect(eleventh).toBe(429);
  });
});
