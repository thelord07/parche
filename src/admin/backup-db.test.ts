/**
 * Tests for the backup-db admin command.
 *
 * Verifies that:
 * 1. The backup file passes `PRAGMA integrity_check` = 'ok'.
 * 2. The backup contains the groups that were in the source DB.
 * 3. The backup works correctly with WAL mode active.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { backupDb, createGroup } from './commands.js';

describe('backupDb', () => {
  let dataDir: string;
  let backupDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'parche-backup-src-'));
    backupDir = await mkdtemp(join(tmpdir(), 'parche-backup-dst-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(backupDir, { recursive: true, force: true });
  });

  it('produces a valid backup that passes integrity_check and contains the groups', async () => {
    // Open source DB and seed data
    const { db, raw } = await openDb(dataDir);
    runMigrations(raw);

    // Confirm WAL mode is active
    const journalMode = raw.pragma('journal_mode') as Array<{ journal_mode: string }>;
    expect(journalMode[0]?.journal_mode).toBe('wal');

    // Create two groups to have something to verify after backup
    createGroup(db, {
      name: 'Alpha Group',
      slug: 'alpha',
      ownerName: 'Alice',
      ownerEmail: 'alice@example.com',
    });
    createGroup(db, {
      name: 'Beta Group',
      slug: 'beta',
      ownerName: 'Bob',
      ownerEmail: 'bob@example.com',
    });

    const destPath = join(backupDir, 'parche-backup.db');

    // Run backup
    await backupDb(raw, destPath);

    raw.close();

    // Open the backup with a plain better-sqlite3 instance (no Drizzle needed)
    const backupRaw = new Database(destPath, { readonly: true });

    try {
      // 1. integrity_check must return 'ok'
      const integrityResult = backupRaw.pragma('integrity_check') as Array<{
        integrity_check: string;
      }>;
      expect(integrityResult[0]?.integrity_check).toBe('ok');

      // 2. Backup must contain the groups
      const rows = backupRaw.prepare('SELECT slug FROM groups ORDER BY slug').all() as Array<{
        slug: string;
      }>;
      const slugs = rows.map((r) => r.slug);
      expect(slugs).toContain('alpha');
      expect(slugs).toContain('beta');
    } finally {
      backupRaw.close();
    }
  });

  it('creates a missing destination directory (backup.sh never creates it on the host)', async () => {
    const { raw } = await openDb(dataDir);
    runMigrations(raw);
    const destPath = join(backupDir, 'nested', '.backup-tmp', 'parche.db');

    await backupDb(raw, destPath);
    raw.close();

    const backupRaw = new Database(destPath, { readonly: true });
    try {
      const result = backupRaw.pragma('integrity_check') as Array<{ integrity_check: string }>;
      expect(result[0]?.integrity_check).toBe('ok');
    } finally {
      backupRaw.close();
    }
  });
});
