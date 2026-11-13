import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupDir, makeApp, makeTempDataDir } from '../test-helpers.js';

const require = createRequire(import.meta.url);

describe('GET /health', () => {
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

  it('returns 200 with status ok', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ status: string; version: string }>();
    expect(body.status).toBe('ok');
  });

  it('AC2: version matches package.json', async () => {
    const pkg = require('../../package.json') as { version: string };
    const response = await app.inject({ method: 'GET', url: '/health' });
    const body = response.json<{ status: string; version: string }>();
    expect(body.version).toBe(pkg.version);
  });

  it('PARCHE-012/PARCHE-013: secretScan field exists and reaches done', async () => {
    let state = 'idle';
    for (let i = 0; i < 50 && state !== 'done'; i++) {
      const response = await app.inject({ method: 'GET', url: '/health' });
      const body = response.json<{
        secretScan: {
          state: string;
          rulesVersion: string | null;
          pending: number;
          scanned: number;
        };
      }>();
      expect(body).toHaveProperty('secretScan');
      expect(body.secretScan).toHaveProperty('state');
      expect(body.secretScan).toHaveProperty('rulesVersion');
      expect(body.secretScan).toHaveProperty('pending');
      expect(body.secretScan).toHaveProperty('scanned');
      state = body.secretScan.state;
      if (state !== 'done') await new Promise((r) => setTimeout(r, 20));
    }
    expect(state).toBe('done');
  });

  it('PARCHE-013: /health never leaks a path or a secret value in secretScan', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    const text = response.body;
    // rulesVersion is a semver string (e.g. "1.15.1"), never a path or a value.
    expect(text).not.toMatch(/\.md|\.canvas|\.base|\.svg/);
  });
});
