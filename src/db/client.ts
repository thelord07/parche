import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

export type AppDb = BetterSQLite3Database<typeof schema>;

/**
 * The raw better-sqlite3 handle type (Database.Database = BetterSqlite3.Database).
 * Exported so server.ts can type the Fastify decoration without importing
 * better-sqlite3 as a value (which would break verbatimModuleSyntax if unused).
 */
export type RawDb = Database.Database;

/**
 * Open (or create) the parche.db database in `dataDir`.
 * Creates the directory if it does not exist.
 * Sets WAL mode, foreign keys, and busy_timeout.
 */
export async function openDb(dataDir: string): Promise<{ db: AppDb; raw: RawDb }> {
  await mkdir(dataDir, { recursive: true });

  const raw = new Database(join(dataDir, 'parche.db'));
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  raw.pragma('busy_timeout = 5000');

  const db = drizzle(raw, { schema });
  return { db, raw };
}
