import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { SentMessageInfo } from 'nodemailer';
import nodemailer from 'nodemailer';
import { createGroup } from './admin/commands.js';
import { generateSessionSecret, hashToken } from './auth/tokens.js';
import { SESSION_MAX_AGE } from './auth/web-session.js';
import type { Config } from './config.js';
import { groups, members, sessions, users } from './db/schema.js';
import { newId } from './ids.js';
import { buildServer } from './server.js';

// ---------------------------------------------------------------------------
// Temp directories
// ---------------------------------------------------------------------------

/**
 * Create a fresh temporary data directory for a test.
 * Returns the directory path. Clean it up in afterEach with cleanupDir().
 */
export async function makeTempDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'parche-test-'));
}

/**
 * Remove a temporary directory created by makeTempDataDir.
 */
export async function cleanupDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Build a test config using the given dataDir. Uses logLevel 'silent' and
 * a default maxBlobBytes of 20 MiB unless overridden.
 */
export function makeConfig(dataDir: string, overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    dataDir,
    maxBlobBytes: 20971520,
    logLevel: 'silent',
    trustProxy: '',
    publicUrl: 'http://localhost:8787',
    smtpUrl: undefined,
    mailFrom: 'parche@localhost',
    creators: [],
    isProduction: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// In-memory mail transport
// ---------------------------------------------------------------------------

export interface InMemoryTransport {
  /** All sent messages */
  sent: SentMessageInfo[];
  /** The nodemailer transporter backed by this in-memory transport */
  transporter: ReturnType<typeof nodemailer.createTransport>;
}

/**
 * Create a nodemailer in-memory transport that captures sent messages.
 * Use `transport.sent` to inspect emails in tests.
 */
export function createTestTransport(): InMemoryTransport {
  const sent: SentMessageInfo[] = [];

  // jsonTransport captures the message as JSON
  const transporter = nodemailer.createTransport({ jsonTransport: true });

  // Wrap sendMail to capture into our array
  const originalSendMail = transporter.sendMail.bind(transporter);
  transporter.sendMail = async (mailOptions) => {
    const info = await originalSendMail(mailOptions);
    sent.push(info);
    return info;
  };

  return { sent, transporter };
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

/**
 * Build a Fastify app instance ready for inject() calls.
 * Uses an in-memory mail transport by default (no SMTP needed).
 */
export async function makeApp(
  dataDir: string,
  overrides: Partial<Config> = {},
  extraOpts: {
    transport?: ReturnType<typeof nodemailer.createTransport>;
    webDir?: string;
    onBackgroundWork?: (p: Promise<void>) => void;
  } = {},
): Promise<FastifyInstance> {
  const config = makeConfig(dataDir, overrides);
  const { transport, webDir, onBackgroundWork } = extraOpts;

  // Use provided transport or create a default test transport
  const mailTransport = transport ?? createTestTransport().transporter;

  return buildServer(config, { transport: mailTransport, webDir, onBackgroundWork });
}

// ---------------------------------------------------------------------------
// Seed helpers for tests that need authenticated devices
// ---------------------------------------------------------------------------

export interface SeededDevice {
  /** Plain-text device token, ready to use as Bearer token */
  token: string;
  /** `Authorization: Bearer <token>` header value */
  authHeader: string;
  groupId: string;
  groupSlug: string;
  userId: string;
  deviceId: string;
}

/**
 * Seed a group + owner device in the given app and return auth credentials.
 * Useful for setting up authenticated requests in blob/change/push tests.
 */
export async function seedGroupWithDevice(
  app: FastifyInstance,
  options: {
    slug?: string;
    ownerName?: string;
    ownerEmail?: string;
  } = {},
): Promise<SeededDevice> {
  const slug = options.slug ?? `test-group-${Math.random().toString(36).slice(2, 8)}`;
  const ownerName = options.ownerName ?? 'Test Owner';
  const ownerEmail = options.ownerEmail ?? `owner-${slug}@example.com`;

  const result = createGroup(app.db, {
    name: slug,
    slug,
    ownerName,
    ownerEmail,
  });

  return {
    token: result.deviceToken,
    authHeader: `Bearer ${result.deviceToken}`,
    groupId: result.groupId,
    groupSlug: slug,
    userId: result.userId,
    deviceId: result.deviceId,
  };
}

// ---------------------------------------------------------------------------
// Web session seed helpers (B8)
// ---------------------------------------------------------------------------

export interface SeededWebUser {
  userId: string;
  email: string;
  name: string;
}

/**
 * Seed a web user (no device). Returns userId, email, name.
 */
export function seedWebUser(
  app: FastifyInstance,
  opts: { email: string; name?: string } = { email: 'test@example.com' },
): SeededWebUser {
  const email = opts.email.toLowerCase().trim();
  const name = opts.name ?? email.split('@')[0] ?? 'user';
  const now = new Date().toISOString();

  const existing = app.db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(eq(users.email, email))
    .get();

  if (existing) {
    return { userId: existing.id, email: existing.email, name: existing.name };
  }

  const userId = newId();
  app.db
    .insert(users)
    .values({ id: userId, name, email, emailVerifiedAt: now, createdAt: now })
    .run();

  return { userId, email, name };
}

/**
 * Seed a web session for a user and return the plain-text session secret (cookie value).
 */
export function seedWebSession(app: FastifyInstance, userId: string): string {
  const secret = generateSessionSecret();
  const tokenHash = hashToken(secret);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE * 1000).toISOString();

  app.db
    .insert(sessions)
    .values({
      id: newId(),
      userId,
      tokenHash,
      createdAt: now,
      expiresAt,
    })
    .run();

  return secret;
}

/**
 * Seed a member relationship. The user must exist.
 */
export function seedMember(
  app: FastifyInstance,
  opts: { groupSlug: string; userId: string; role: string },
): void {
  const grp = app.db
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.slug, opts.groupSlug))
    .get();

  if (!grp) throw new Error(`Group '${opts.groupSlug}' not found`);

  const now = new Date().toISOString();

  const existing = app.db
    .select({ groupId: members.groupId })
    .from(members)
    .where(and(eq(members.groupId, grp.id), eq(members.userId, opts.userId)))
    .get();

  if (existing) {
    app.db
      .update(members)
      .set({ role: opts.role, removedAt: null })
      .where(and(eq(members.groupId, grp.id), eq(members.userId, opts.userId)))
      .run();
  } else {
    app.db
      .insert(members)
      .values({ groupId: grp.id, userId: opts.userId, role: opts.role, createdAt: now })
      .run();
  }
}

// ---------------------------------------------------------------------------
// SPA fixture helper (B7/B8 - shared between auth.verify.test and spa-fallback.test)
// ---------------------------------------------------------------------------

export interface WebFixture {
  webDir: string;
  cleanup: () => Promise<void>;
}

/**
 * Create a temporary directory with a fixture index.html for SPA tests.
 * Returns the directory path and a cleanup function.
 */
export async function withWebFixture(): Promise<WebFixture> {
  const webDir = await mkdtemp(join(tmpdir(), 'parche-web-fixture-'));
  await writeFile(
    join(webDir, 'index.html'),
    '<!DOCTYPE html><html><head><title>parche</title></head><body><div id="root"></div></body></html>',
  );
  return {
    webDir,
    cleanup: () => rm(webDir, { recursive: true, force: true }),
  };
}
