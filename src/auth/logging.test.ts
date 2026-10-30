/**
 * Verifies that pino redacts Bearer tokens and deviceToken from logs.
 */
import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGroup, createInvite } from '../admin/commands.js';
import { buildServer } from '../server.js';
import { cleanupDir, makeConfig, makeTempDataDir } from '../test-helpers.js';

describe('auth logging redaction', () => {
  let dataDir: string;
  let app: FastifyInstance;
  let logOutput: string;
  let logStream: PassThrough;

  beforeEach(async () => {
    dataDir = await makeTempDataDir();
    logOutput = '';
    logStream = new PassThrough();
    logStream.on('data', (chunk: Buffer) => {
      logOutput += chunk.toString();
    });

    app = await buildServer({ ...makeConfig(dataDir), logLevel: 'info' }, { logStream });

    // Seed a group + invite so we can join
    createGroup(app.db, {
      name: 'Log Group',
      slug: 'log-group',
      ownerName: 'Owner',
      ownerEmail: 'owner@log.com',
    });
  });

  afterEach(async () => {
    await app.close();
    await cleanupDir(dataDir);
  });

  it('Bearer token in Authorization header is redacted in logs', async () => {
    const { inviteCode } = createInvite(app.db, { group: 'log-group', role: 'reader' });
    const joinRes = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { code: inviteCode, name: 'Reader', email: 'reader@log.com' },
    });
    expect(joinRes.statusCode).toBe(200);
    const { deviceToken } = joinRes.json() as { deviceToken: string };

    // Make an authenticated request that would log the Authorization header
    await app.inject({
      method: 'GET',
      url: '/api/g/log-group/changes',
      headers: { authorization: `Bearer ${deviceToken}` },
    });

    // The raw pch_ token must never appear in logs
    expect(logOutput).not.toContain(deviceToken);
    expect(logOutput).not.toContain('pch_');
  });

  it('deviceToken in join response body is redacted in logs', async () => {
    const { inviteCode } = createInvite(app.db, { group: 'log-group', role: 'reader' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { code: inviteCode, name: 'Second', email: 'second@log.com' },
    });
    expect(res.statusCode).toBe(200);
    const { deviceToken } = res.json() as { deviceToken: string };

    // The plain token must not appear in any log line
    expect(logOutput).not.toContain(deviceToken);
  });
});
