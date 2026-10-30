/**
 * AC4: DB stores only hashes; no token or cookie secret appears in pino logs or stdout.
 */
import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateMagicToken, hashToken } from '../../auth/tokens.js';
import { magicLinks, sessions } from '../../db/schema.js';
import { newId } from '../../ids.js';
import {
  cleanupDir,
  createTestTransport,
  makeApp,
  makeConfig,
  makeTempDataDir,
  seedWebUser,
  type WebFixture,
  withWebFixture,
} from '../../test-helpers.js';
import { resetEmailCounters } from './auth.js';

const CSRF_HEADERS = {
  'content-type': 'application/json',
  'x-parche-csrf': '1',
};

describe('AC4 — tokens and secrets never in logs or stdout', () => {
  let dataDir: string;
  let app: FastifyInstance;
  let testTransport: ReturnType<typeof createTestTransport>;
  let logOutput: string;
  let stdoutWrites: string;
  let stdoutWrite: typeof process.stdout.write;
  let fixture: WebFixture;
  let backgroundWorkPromises: Promise<void>[];

  beforeEach(async () => {
    dataDir = await makeTempDataDir();
    testTransport = createTestTransport();
    backgroundWorkPromises = [];
    fixture = await withWebFixture();

    logOutput = '';
    const logStream = new PassThrough();
    logStream.on('data', (chunk: Buffer) => {
      logOutput += chunk.toString();
    });

    // Capture process.stdout.write
    stdoutWrites = '';
    stdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array) => {
      stdoutWrites += typeof chunk === 'string' ? chunk : chunk.toString();
      return stdoutWrite(chunk as string);
    };

    app = await makeApp(
      dataDir,
      makeConfig(dataDir, {
        creators: ['creator@example.com'],
        publicUrl: 'http://localhost:8787',
        logLevel: 'info',
      }),
      {
        transport: testTransport.transporter,
        webDir: fixture.webDir,
        onBackgroundWork: (p) => backgroundWorkPromises.push(p),
      },
    );
    resetEmailCounters();
  });

  afterEach(async () => {
    process.stdout.write = stdoutWrite;
    await app.close();
    await cleanupDir(dataDir);
    await fixture.cleanup();
    resetEmailCounters();
  });

  it('DB stores only hash (64-char hex), not plain token; token absent from logs and stdout', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/web/auth/request',
      headers: CSRF_HEADERS,
      payload: { email: 'creator@example.com' },
    });
    expect(res.statusCode).toBe(200);
    await Promise.all(backgroundWorkPromises);

    const rows = app.db.select().from(magicLinks).all();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.tokenHash).not.toBeUndefined();

    // No 64-char hex string (token or hash) should appear in pino logs or stdout
    // A plain magic token is a 64-char hex string; the hash is also 64-char hex.
    // Neither should ever be printed.
    expect(logOutput).not.toMatch(/[0-9a-f]{64}/);
    expect(stdoutWrites).not.toMatch(/[0-9a-f]{64}/);
  });

  it('session token_hash stored as 64-char hex, not plain secret', async () => {
    seedWebUser(app, { email: 'creator@example.com' });

    // Insert magic link directly
    const token = generateMagicToken();
    const tokenHash = hashToken(token);
    const now = new Date().toISOString();
    app.db
      .insert(magicLinks)
      .values({
        id: newId(),
        email: 'creator@example.com',
        tokenHash,
        createdAt: now,
        expiresAt: new Date(Date.now() + 900000).toISOString(),
      })
      .run();

    const res = await app.inject({
      method: 'POST',
      url: '/api/web/auth/verify',
      headers: CSRF_HEADERS,
      payload: { token },
    });
    expect(res.statusCode).toBe(200);

    // Get the cookie secret value
    const setCookie = res.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const secret = cookieStr?.match(/parche_session=([^;]+)/)?.[1];
    expect(secret).toBeDefined();

    // Verify session stored hash, not plain secret
    const sessionRows = app.db.select().from(sessions).all();
    expect(sessionRows).toHaveLength(1);
    const storedHash = sessionRows[0]?.tokenHash;
    expect(storedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(storedHash).not.toBe(secret);
    expect(storedHash).toBe(hashToken(secret as string));

    // Neither plain token nor plain secret appears in pino logs
    expect(logOutput).not.toContain(token);
    expect(logOutput).not.toContain(secret);

    // Neither appears in stdout
    expect(stdoutWrites).not.toContain(token);
    expect(stdoutWrites).not.toContain(secret);
  });
});
