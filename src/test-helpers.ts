import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createGroup } from './admin/commands.js';
import type { Config } from './config.js';
import { buildServer } from './server.js';

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
    ...overrides,
  };
}

/**
 * Build a Fastify app instance ready for inject() calls.
 */
export async function makeApp(
  dataDir: string,
  overrides: Partial<Config> = {},
): Promise<FastifyInstance> {
  const config = makeConfig(dataDir, overrides);
  return buildServer(config);
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
