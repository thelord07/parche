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
});
