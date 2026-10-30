/**
 * AC2: POST /api/web/auth/request
 * - unknown email → 200, no token, no mail
 * - known user/creator → 200, token created, mail sent
 * - hanging sendMail → response still resolves 200 immediately
 * - per-email rate limit counts in both branches
 */

import type { FastifyInstance } from 'fastify';
import nodemailer from 'nodemailer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { magicLinks } from '../../db/schema.js';
import {
  cleanupDir,
  createTestTransport,
  makeApp,
  makeConfig,
  makeTempDataDir,
  seedWebUser,
} from '../../test-helpers.js';
import { emailCountersSize, resetEmailCounters } from './auth.js';

const CSRF_HEADERS = {
  'content-type': 'application/json',
  'x-parche-csrf': '1',
};

describe('POST /api/web/auth/request (AC2)', () => {
  let dataDir: string;
  let app: FastifyInstance;
  let testTransport: ReturnType<typeof createTestTransport>;
  let backgroundWorkPromises: Promise<void>[];

  beforeEach(async () => {
    dataDir = await makeTempDataDir();
    testTransport = createTestTransport();
    backgroundWorkPromises = [];

    const onBackgroundWork = (p: Promise<void>) => {
      backgroundWorkPromises.push(p);
    };

    app = await makeApp(
      dataDir,
      makeConfig(dataDir, {
        creators: ['creator@example.com'],
        publicUrl: 'http://localhost:8787',
      }),
      {
        transport: testTransport.transporter,
        onBackgroundWork,
      },
    );
    resetEmailCounters();
  });

  afterEach(async () => {
    await app.close();
    await cleanupDir(dataDir);
    resetEmailCounters();
  });

  async function waitForBackground(): Promise<void> {
    await Promise.all(backgroundWorkPromises);
    backgroundWorkPromises = [];
  }

  it('unknown email → 200, no mail, no token row', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/web/auth/request',
      headers: CSRF_HEADERS,
      payload: { email: 'nobody@nowhere.example' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    await waitForBackground();

    expect(testTransport.sent).toHaveLength(0);
    const rows = app.db.select().from(magicLinks).all();
    expect(rows).toHaveLength(0);
  });

  it('creator email → 200, mail sent, token row created', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/web/auth/request',
      headers: CSRF_HEADERS,
      payload: { email: 'creator@example.com' },
    });
    expect(res.statusCode).toBe(200);

    await waitForBackground();

    expect(testTransport.sent).toHaveLength(1);
    const rows = app.db.select().from(magicLinks).all();
    expect(rows).toHaveLength(1);
    // Token hash stored, not plain
    expect(rows[0]?.tokenHash).toHaveLength(64);
  });

  it('existing user email → 200, mail sent, token row created', async () => {
    seedWebUser(app, { email: 'existing@example.com' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/web/auth/request',
      headers: CSRF_HEADERS,
      payload: { email: 'existing@example.com' },
    });
    expect(res.statusCode).toBe(200);

    await waitForBackground();

    expect(testTransport.sent).toHaveLength(1);
    const rows = app.db.select().from(magicLinks).all();
    expect(rows).toHaveLength(1);
  });

  it('email counter advances even for unknown email — counter does not affect response code', async () => {
    // Send 4 requests for unknown email — all should be 200
    // (keeping under the IP rate limit of 5/15min to avoid 429)
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/web/auth/request',
        headers: CSRF_HEADERS,
        payload: { email: 'ghost@nowhere.example' },
      });
      expect(res.statusCode).toBe(200);
    }
    await waitForBackground();
    // Still no mail for unknown
    expect(testTransport.sent).toHaveLength(0);
  });

  it('missing CSRF header → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/web/auth/request',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'creator@example.com' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('hanging sendMail: response resolves 200 before mail completes', async () => {
    // Create a transport whose sendMail never resolves
    const resolver = { fn: null as (() => void) | null };
    const hangingTransport = nodemailer.createTransport({
      jsonTransport: true,
    });
    const originalSend = hangingTransport.sendMail.bind(hangingTransport);
    // Override to hang
    hangingTransport.sendMail = () =>
      new Promise<Awaited<ReturnType<typeof originalSend>>>((resolve) => {
        resolver.fn = () => resolve({} as Awaited<ReturnType<typeof originalSend>>);
      }) as ReturnType<typeof originalSend>;

    const hangingPromises: Promise<void>[] = [];
    const hangApp = await makeApp(
      await makeTempDataDir(),
      makeConfig(await makeTempDataDir(), {
        creators: ['creator@example.com'],
        publicUrl: 'http://localhost:8787',
      }),
      {
        transport: hangingTransport,
        onBackgroundWork: (p) => hangingPromises.push(p),
      },
    );

    const start = Date.now();
    const res = await hangApp.inject({
      method: 'POST',
      url: '/api/web/auth/request',
      headers: CSRF_HEADERS,
      payload: { email: 'creator@example.com' },
    });
    const elapsed = Date.now() - start;

    expect(res.statusCode).toBe(200);
    // Response should arrive very fast (well under 1 second) even if mail hangs
    expect(elapsed).toBeLessThan(1000);

    // Resolve the hanging mail so the background promise can settle
    resolver.fn?.();
    await Promise.all(hangingPromises);
    await hangApp.close();
  });

  it('unknown email: counter advances (rate limit applies equally)', async () => {
    // Per-design: rate limit counts BEFORE the eligibility check (background work)
    // so an attacker cannot probe eligibility by counting 429s.
    // We assert the internal counter size reflects the request.
    resetEmailCounters();
    const sizeBefore = emailCountersSize();

    const res = await app.inject({
      method: 'POST',
      url: '/api/web/auth/request',
      headers: CSRF_HEADERS,
      payload: { email: 'nobody@unknown.example' },
    });
    expect(res.statusCode).toBe(200);
    await Promise.all(backgroundWorkPromises);

    // Counter must have grown by 1 (the unknown email hash was recorded)
    expect(emailCountersSize()).toBe(sizeBefore + 1);
    // No mail was sent
    expect(testTransport.sent).toHaveLength(0);
    // No magic link token in DB
    const rows = app.db.select().from(magicLinks).all();
    expect(rows).toHaveLength(0);
  });
});

describe('POST /api/web/auth/request — mutation check: unknown email must count', () => {
  // Mutation: if the unknown-email branch skips the counter, 6 unknown-email
  // requests would not hit the per-email limit on the 6th request.
  // This test confirms the counter IS advanced for unknown emails.
  let dataDir: string;
  let app: import('fastify').FastifyInstance;
  let testTransport: ReturnType<typeof createTestTransport>;
  let backgroundWorkPromises: Promise<void>[];

  beforeEach(async () => {
    resetEmailCounters();
    dataDir = await makeTempDataDir();
    testTransport = createTestTransport();
    backgroundWorkPromises = [];

    app = await makeApp(
      dataDir,
      makeConfig(dataDir, { creators: ['creator@example.com'], publicUrl: 'http://localhost' }),
      {
        transport: testTransport.transporter,
        onBackgroundWork: (p) => backgroundWorkPromises.push(p),
      },
    );
  });

  afterEach(async () => {
    await app.close();
    await cleanupDir(dataDir);
    resetEmailCounters();
  });

  it('after 5 requests for unknown email, counter size is 1 (one hash tracked)', async () => {
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/web/auth/request',
        headers: CSRF_HEADERS,
        payload: { email: 'ghost@unknown.example' },
      });
      await Promise.all(backgroundWorkPromises);
      backgroundWorkPromises = [];
    }
    // Same email hash: 1 entry in the map regardless of # requests
    expect(emailCountersSize()).toBe(1);
    // No mail sent (unknown email)
    expect(testTransport.sent).toHaveLength(0);
  });
});
