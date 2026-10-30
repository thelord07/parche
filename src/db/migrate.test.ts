import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupDir, makeApp, makeTempDataDir } from '../test-helpers.js';

// Table names created by the schema migrations
const EXPECTED_TABLES = [
  'groups',
  'users',
  'members',
  'devices',
  'invites',
  'files',
  'changes',
  'blob_refs',
  'sessions',
  'magic_links',
];

describe('migration files are additive-only', () => {
  it('no migration file contains DROP TABLE, DROP COLUMN, or DELETE FROM', () => {
    const migrationsDir = join(import.meta.dirname, 'migrations');
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
    for (const file of files) {
      const sql = readFileSync(join(migrationsDir, file), 'utf-8').toUpperCase();
      expect(sql, `${file} must not contain DROP TABLE`).not.toMatch(/DROP\s+TABLE/);
      expect(sql, `${file} must not contain DROP COLUMN`).not.toMatch(/DROP\s+COLUMN/);
      expect(sql, `${file} must not contain DELETE FROM`).not.toMatch(/DELETE\s+FROM/);
    }
  });
});

describe('DB migrations', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await makeTempDataDir();
  });

  afterEach(async () => {
    await cleanupDir(dataDir);
  });

  it('creates parche.db and all expected tables on first buildServer', async () => {
    const app = await makeApp(dataDir);
    try {
      // parche.db must exist
      expect(existsSync(join(dataDir, 'parche.db'))).toBe(true);

      // All 8 tables must be present in sqlite_master
      const rows = app.rawDb
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'",
        )
        .all() as Array<{ name: string }>;

      const tableNames = rows.map((r) => r.name).sort();
      expect(tableNames).toEqual([...EXPECTED_TABLES].sort());
    } finally {
      await app.close();
    }
  });

  it('second buildServer on the same dataDir is idempotent — migration count stable', async () => {
    // First boot
    const app1 = await makeApp(dataDir);
    const countAfterFirst = (
      app1.rawDb.prepare('SELECT COUNT(*) as n FROM __drizzle_migrations').get() as { n: number }
    ).n;
    await app1.close();

    // Second boot — must not fail and must not add new migration rows
    const app2 = await makeApp(dataDir);
    try {
      const countAfterSecond = (
        app2.rawDb.prepare('SELECT COUNT(*) as n FROM __drizzle_migrations').get() as { n: number }
      ).n;
      expect(countAfterSecond).toBe(countAfterFirst);
    } finally {
      await app2.close();
    }
  });

  it('WAL mode is active after boot', async () => {
    const app = await makeApp(dataDir);
    try {
      const row = app.rawDb.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      expect(row.journal_mode).toBe('wal');
    } finally {
      await app.close();
    }
  });

  it('foreign keys are enabled', async () => {
    const app = await makeApp(dataDir);
    try {
      const row = app.rawDb.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
      expect(row.foreign_keys).toBe(1);
    } finally {
      await app.close();
    }
  });
});
