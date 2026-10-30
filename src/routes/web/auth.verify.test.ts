/**
 * AC3: POST /api/web/auth/verify
 * - N GET /auth (token in fragment, never sent to server) do not consume (scanner test)
 * - POST consumes → 200 + cookie
 * - 2nd POST → 410
 * - expired → 410
 * - session rotation
 * - cookie attributes (HttpOnly, SameSite=Lax)
 */

import { eq } from 'drizzle-orm';
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
  seedWebSession,
  seedWebUser,
  type WebFixture,
  withWebFixture,
} from '../../test-helpers.js';
import { resetEmailCounters } from './auth.js';

const CSRF_HEADERS = {
  'content-type': 'application/json',
  'x-parche-csrf': '1',
};

describe('POST /api/web/auth/verify (AC3)', () => {
  let dataDir: string;
  let app: FastifyInstance;
  let testTransport: ReturnType<typeof createTestTransport>;
  let backgroundWorkPromises: Promise<void>[];
  let fixture: WebFixture;

  beforeEach(async () => {
    dataDir = await makeTempDataDir();
    testTransport = createTestTransport();
    backgroundWorkPromises = [];
    fixture = await withWebFixture();

    app = await makeApp(
      dataDir,
      makeConfig(dataDir, {
        creators: ['creator@example.com'],
        publicUrl: 'http://localhost:8787',
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
    await app.close();
    await cleanupDir(dataDir);
    await fixture.cleanup();
    resetEmailCounters();
  });

  function insertMagicLink(email: string, opts: { expired?: boolean } = {}): string {
    const token = generateMagicToken();
    const tokenHash = hashToken(token);
    const now = new Date().toISOString();
    const expiresAt = opts.expired
      ? new Date(Date.now() - 1000).toISOString()
      : new Date(Date.now() + 15 * 60 * 1000).toISOString();

    app.db
      .insert(magicLinks)
      .values({
        id: newId(),
        email,
        tokenHash,
        createdAt: now,
        expiresAt,
      })
      .run();

    return token;
  }

  it('N GET /auth (fragment not sent) leaves token valid (scanner test)', async () => {
    const token = insertMagicLink('creator@example.com');

    // Simulate N GET requests exactly as a browser would send them:
    // the fragment (#token) is never transmitted, so the server only sees GET /auth.
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/auth',
        headers: { accept: 'text/html' },
      });
      expect(res.statusCode).toBe(200);
    }

    // Token still unused in DB
    const link = app.db
      .select({ usedAt: magicLinks.usedAt })
      .from(magicLinks)
      .where(eq(magicLinks.tokenHash, hashToken(token)))
      .get();
    expect(link?.usedAt).toBeNull();

    // POST consumes it
    const res = await app.inject({
      method: 'POST',
      url: '/api/web/auth/verify',
      headers: CSRF_HEADERS,
      payload: { token },
    });
    expect(res.statusCode).toBe(200);
  });

  it('POST verify → 200, sets parche_session cookie with HttpOnly + SameSite=Lax', async () => {
    // Seed user
    seedWebUser(app, { email: 'creator@example.com' });
    const token = insertMagicLink('creator@example.com');

    const res = await app.inject({
      method: 'POST',
      url: '/api/web/auth/verify',
      headers: CSRF_HEADERS,
      payload: { token },
    });
    expect(res.statusCode).toBe(200);

    const setCookie = res.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieStr).toBeDefined();
    expect(cookieStr).toMatch(/parche_session=/);
    expect(cookieStr?.toLowerCase()).toMatch(/httponly/);
    expect(cookieStr?.toLowerCase()).toMatch(/samesite=lax/);
  });

  it('2nd POST with same token → 410', async () => {
    seedWebUser(app, { email: 'creator@example.com' });
    const token = insertMagicLink('creator@example.com');

    // First verify
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/web/auth/verify',
      headers: CSRF_HEADERS,
      payload: { token },
    });
    expect(res1.statusCode).toBe(200);

    // Second verify
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/web/auth/verify',
      headers: CSRF_HEADERS,
      payload: { token },
    });
    expect(res2.statusCode).toBe(410);
    expect(res2.json()).toMatchObject({ error: 'link' });
  });

  it('expired token → 410', async () => {
    seedWebUser(app, { email: 'creator@example.com' });
    const token = insertMagicLink('creator@example.com', { expired: true });

    const res = await app.inject({
      method: 'POST',
      url: '/api/web/auth/verify',
      headers: CSRF_HEADERS,
      payload: { token },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ error: 'link' });
  });

  it('session rotation: previous session gets revoked_at set', async () => {
    const { userId } = seedWebUser(app, { email: 'creator@example.com' });
    const prevSecret = seedWebSession(app, userId);

    const token = insertMagicLink('creator@example.com');

    const res = await app.inject({
      method: 'POST',
      url: '/api/web/auth/verify',
      headers: {
        ...CSRF_HEADERS,
        cookie: `parche_session=${prevSecret}`,
      },
      payload: { token },
    });
    expect(res.statusCode).toBe(200);

    // Old session revoked
    const prevHash = hashToken(prevSecret);
    const oldSession = app.db
      .select({ revokedAt: sessions.revokedAt })
      .from(sessions)
      .where(eq(sessions.tokenHash, prevHash))
      .get();
    expect(oldSession?.revokedAt).not.toBeNull();

    // New session created
    const allSessions = app.db.select().from(sessions).all();
    const activeSessions = allSessions.filter((s) => s.revokedAt === null);
    expect(activeSessions).toHaveLength(1);
  });

  it('creator with no existing user → user created on verify', async () => {
    const token = insertMagicLink('newcreator@example.com');

    // Create a new app with newcreator in creators list
    await app.close();
    app = await makeApp(
      dataDir,
      makeConfig(dataDir, {
        creators: ['newcreator@example.com'],
        publicUrl: 'http://localhost:8787',
      }),
      {
        transport: testTransport.transporter,
        webDir: fixture.webDir,
      },
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/web/auth/verify',
      headers: CSRF_HEADERS,
      payload: { token },
    });
    expect(res.statusCode).toBe(200);

    // User was created
    const { users } = await import('../../db/schema.js');
    const user = app.db.select().from(users).where(eq(users.email, 'newcreator@example.com')).get();
    expect(user).toBeDefined();
    expect(user?.emailVerifiedAt).not.toBeNull();
  });

  it('cookie is NOT Secure in dev (isProduction=false)', async () => {
    const token = insertMagicLink('creator@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/web/auth/verify',
      headers: CSRF_HEADERS,
      payload: { token },
    });
    expect(res.statusCode).toBe(200);
    const setCookie = res.headers['set-cookie'] as string;
    expect(setCookie).toBeDefined();
    // In dev, Secure flag must NOT be present
    expect(setCookie.toLowerCase()).not.toContain('secure');
  });

  it('cookie IS Secure in production (isProduction=true)', async () => {
    // Create app in production mode
    await app.close();
    app = await makeApp(
      dataDir,
      makeConfig(dataDir, {
        creators: ['creator@example.com'],
        publicUrl: 'http://localhost:8787',
        isProduction: true,
      }),
      {
        transport: testTransport.transporter,
        webDir: fixture.webDir,
      },
    );

    const token = insertMagicLink('creator@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/web/auth/verify',
      headers: CSRF_HEADERS,
      payload: { token },
    });
    expect(res.statusCode).toBe(200);
    const setCookie = res.headers['set-cookie'] as string;
    expect(setCookie).toBeDefined();
    // In production, Secure flag must be present
    expect(setCookie.toLowerCase()).toContain('secure');
  });
});
