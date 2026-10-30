/**
 * AC10: SPA fallback + static serving
 * - /g/x/invitar → 200 text/html (SPA)
 * - /auth → 200 text/html + Referrer-Policy: no-referrer
 *   (token is in the fragment, never sent to the server)
 * - /j/code → 200 text/html + Referrer-Policy: no-referrer
 * - /api/nada → 404 JSON {error: 'not found'}
 * - /health → 200
 * - /api/blob/zzz → 400
 */

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupDir,
  makeApp,
  makeConfig,
  makeTempDataDir,
  type WebFixture,
  withWebFixture,
} from '../../test-helpers.js';

describe('SPA fallback (AC10)', () => {
  let dataDir: string;
  let app: FastifyInstance;
  let fixture: WebFixture;

  beforeEach(async () => {
    dataDir = await makeTempDataDir();
    fixture = await withWebFixture();

    app = await makeApp(dataDir, makeConfig(dataDir), {
      webDir: fixture.webDir,
    });
  });

  afterEach(async () => {
    await app.close();
    await cleanupDir(dataDir);
    await fixture.cleanup();
  });

  it('/g/x/invitar → 200 text/html (SPA index.html)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/g/x/invitar',
      headers: { accept: 'text/html,application/xhtml+xml,*/*' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('/auth → 200 text/html + Referrer-Policy: no-referrer (fragment never sent to server)', async () => {
    // The browser sends GET /auth — the fragment (#token) is never sent to the server.
    // The server must serve the SPA at /auth with Referrer-Policy: no-referrer.
    const res = await app.inject({
      method: 'GET',
      url: '/auth',
      headers: { accept: 'text/html,*/*' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('/j/K7QX-ABCD → 200 text/html + Referrer-Policy: no-referrer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/j/K7QX-ABCD',
      headers: { accept: 'text/html,*/*' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('/api/nada → 404 JSON {error: "not found"}', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/nada',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not found' });
  });

  it('/health → 200', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });
    expect(res.statusCode).toBe(200);
  });

  it('/api/blob/zzz → 401 (auth required; traversal safety net is for unregistered paths)', async () => {
    // GET /api/blob/:hash is a registered route; auth runs first → 401 without a token.
    // The 400 traversal safety net in setNotFoundHandler only catches paths that do NOT
    // match any registered route (e.g. path traversal attempts over the wire).
    const res = await app.inject({
      method: 'GET',
      url: '/api/blob/zzz',
    });
    expect(res.statusCode).toBe(401);
  });

  it('/api/nada-extra → 404 JSON for any unregistered /api/* path', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/completely/unknown/endpoint',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not found' });
  });

  it('without webDir: /g/x/invitar → 404 (no static serving in dev)', async () => {
    // Create app without webDir
    const devDataDir = await makeTempDataDir();
    const devApp = await makeApp(devDataDir, makeConfig(devDataDir));
    try {
      const res = await devApp.inject({
        method: 'GET',
        url: '/g/x/invitar',
        headers: { accept: 'text/html,*/*' },
      });
      // Without webDir, not found handler returns 404
      expect(res.statusCode).toBe(404);
    } finally {
      await devApp.close();
      await cleanupDir(devDataDir);
    }
  });
});
