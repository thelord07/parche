/**
 * CSP header tests (D2 / S11)
 *
 * The exact CSP value required by the ticket:
 *   default-src 'self'; img-src 'self' data:; script-src 'self';
 *   style-src 'self' 'unsafe-inline'; frame-ancestors 'none';
 *   base-uri 'none'; form-action 'self'
 *
 * Must be present on:
 * - GET / (index.html)
 * - SPA fallback routes like /g/x/n/a.md (any non-API GET that returns HTML)
 *
 * Also: X-Content-Type-Options: nosniff on all HTML responses.
 */

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupDir, makeApp, makeTempDataDir, withWebFixture } from '../../test-helpers.js';

const EXPECTED_CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
];

describe('D2: CSP headers on HTML responses', () => {
  let dataDir: string;
  let app: FastifyInstance;
  let webDir: string;
  let webCleanup: () => Promise<void>;

  beforeEach(async () => {
    dataDir = await makeTempDataDir();
    const fixture = await withWebFixture();
    webDir = fixture.webDir;
    webCleanup = fixture.cleanup;
    app = await makeApp(dataDir, {}, { webDir });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await cleanupDir(dataDir);
    await webCleanup();
  });

  it('GET / has exact CSP directives', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { accept: 'text/html,*/*' },
    });
    expect(res.statusCode).toBe(200);
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toBeTruthy();
    for (const directive of EXPECTED_CSP) {
      expect(csp, `CSP should contain "${directive}"`).toContain(directive);
    }
  });

  it('GET / has X-Content-Type-Options: nosniff', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { accept: 'text/html,*/*' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('SPA fallback /g/x/n/a.md has exact CSP directives', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/g/x/n/a.md',
      headers: { accept: 'text/html,*/*' },
    });
    expect(res.statusCode).toBe(200);
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toBeTruthy();
    for (const directive of EXPECTED_CSP) {
      expect(csp, `SPA fallback CSP should contain "${directive}"`).toContain(directive);
    }
  });

  it('SPA fallback /g/x/n/a.md has nosniff', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/g/x/n/a.md',
      headers: { accept: 'text/html,*/*' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('CSP not present on JSON (API) responses', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });
    expect(res.statusCode).toBe(200);
    // /health returns JSON — CSP should NOT be on non-HTML
    const csp = res.headers['content-security-policy'];
    const ct = res.headers['content-type'] ?? '';
    if (!ct.includes('text/html')) {
      expect(csp).toBeUndefined();
    }
  });
});
