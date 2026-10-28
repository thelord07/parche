import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
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
