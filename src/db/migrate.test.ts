import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupDir, makeApp, makeTempDataDir } from '../test-helpers.js';
import { runMigrations } from './migrate.js';

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
  'file_meta',
  'secret_findings',
  'secret_scan_state',
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

const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

function readJournal(dir = MIGRATIONS_DIR): { entries: JournalEntry[] } & Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'meta', '_journal.json'), 'utf-8'));
}

/** Copia la carpeta de migraciones real a `dest` aplicando `edit` al journal. */
function migrationsCopy(dest: string, edit: (entries: JournalEntry[]) => JournalEntry[]): string {
  const dir = join(dest, 'migrations');
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const journal = readJournal(dir);
  journal.entries = edit(journal.entries);
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify(journal, null, 2));
  return dir;
}

function tableNames(raw: Database.Database): string[] {
  const rows = raw
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'",
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name).sort();
}

describe('migration journal', () => {
  it('los `when` son estrictamente crecientes en el orden de idx', () => {
    const entries = [...readJournal().entries].sort((a, b) => a.idx - b.idx);
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1] as JournalEntry;
      const cur = entries[i] as JournalEntry;
      expect(
        cur.when,
        `${cur.tag}.when (${cur.when}) debe ser mayor que ${prev.tag}.when (${prev.when}); genera migraciones solo con drizzle-kit generate`,
      ).toBeGreaterThan(prev.when);
    }
  });
});

describe('migration upgrade path', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await makeTempDataDir();
  });

  afterEach(async () => {
    await cleanupDir(tmp);
  });

  it('una base migrada solo hasta 0001 recibe todas las migraciones posteriores', () => {
    const upTo0001 = migrationsCopy(tmp, (entries) => entries.filter((e) => e.idx <= 1));
    const raw = new Database(':memory:');
    try {
      migrate(drizzle(raw), { migrationsFolder: upTo0001 });
      expect(tableNames(raw)).not.toContain('file_meta');

      runMigrations(raw);

      expect(tableNames(raw)).toEqual([...EXPECTED_TABLES].sort());
    } finally {
      raw.close();
    }
  });

  it('una base migrada solo hasta 0002 recibe secret_findings y secret_scan_state (PARCHE-012)', () => {
    const upTo0002 = migrationsCopy(tmp, (entries) => entries.filter((e) => e.idx <= 2));
    const raw = new Database(':memory:');
    try {
      migrate(drizzle(raw), { migrationsFolder: upTo0002 });
      expect(tableNames(raw)).not.toContain('secret_findings');

      runMigrations(raw);

      expect(tableNames(raw)).toEqual([...EXPECTED_TABLES].sort());
    } finally {
      raw.close();
    }
  });

  it('una base creada desde cero con el journal defectuoso de 0002 sigue arrancando', () => {
    const buggy = migrationsCopy(tmp, (entries) =>
      entries.map((e) => (e.tag === '0002_add_file_meta' ? { ...e, when: 1751500000000 } : e)),
    );
    const raw = new Database(':memory:');
    try {
      migrate(drizzle(raw), { migrationsFolder: buggy });
      expect(tableNames(raw)).toContain('file_meta');

      expect(() => runMigrations(raw)).not.toThrow();
      expect(tableNames(raw)).toEqual([...EXPECTED_TABLES].sort());

      // Un segundo arranque no reintenta nada
      const count = () =>
        (raw.prepare('SELECT COUNT(*) as n FROM __drizzle_migrations').get() as { n: number }).n;
      const before = count();
      runMigrations(raw);
      expect(count()).toBe(before);
    } finally {
      raw.close();
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
