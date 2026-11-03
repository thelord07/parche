import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { RawDb } from './client.js';

/**
 * `when` con el que se publicó 0002_add_file_meta en PARCHE-007-A (menor que el
 * de 0001). Ver `reconcileFileMetaMigration`.
 */
const FILE_META_BAD_WHEN = 1751500000000;
const FILE_META_TAG = '0002_add_file_meta';

/**
 * Run pending SQL migrations from the `migrations/` directory co-located
 * with this module.
 *
 * In dev (tsx), import.meta.url resolves to src/db/migrate.ts, so
 * `./migrations` → src/db/migrations/.
 *
 * In production (node dist/main.js or dist/admin-cli.js), tsup bundles this
 * module into the dist root and onSuccess copies src/db/migrations →
 * dist/migrations/, so `./migrations` → dist/migrations/.
 *
 * Drizzle tracks applied migrations in `__drizzle_migrations`; re-running is
 * idempotent and never duplicates entries.
 */
export function runMigrations(raw: RawDb): void {
  const db = drizzle(raw);
  const migrationsFolder = fileURLToPath(new URL('./migrations', import.meta.url));
  reconcileFileMetaMigration(raw, migrationsFolder);
  migrate(db, { migrationsFolder });
}

/**
 * PARCHE-007A-HOTFIX. Drizzle solo aplica migraciones cuyo `when` supera el
 * `created_at` más alto registrado. 0002 se publicó con un `when` menor que 0001:
 * - bases que ya tenían 0001 la saltaron (sin `file_meta`) → con el `when`
 *   corregido el migrador la aplica normalmente;
 * - bases creadas desde cero con ese journal sí tienen `file_meta`, pero su fila
 *   quedó con el `when` viejo, así que el migrador intentaría crearla otra vez y
 *   fallaría. Para esas se registra 0002 con su `when` corregido (solo INSERT).
 */
function reconcileFileMetaMigration(raw: RawDb, migrationsFolder: string): void {
  const hasTable = (name: string) =>
    raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name) !==
    undefined;
  if (!hasTable('__drizzle_migrations') || !hasTable('file_meta')) return;

  // readMigrationFiles devuelve las migraciones en el orden del journal, sin el tag.
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf-8'),
  ) as { entries: Array<{ tag: string }> };
  const idx = journal.entries.findIndex((e) => e.tag === FILE_META_TAG);
  const fileMeta = idx === -1 ? undefined : readMigrationFiles({ migrationsFolder })[idx];
  if (!fileMeta || fileMeta.folderMillis === FILE_META_BAD_WHEN) return;

  const recorded = raw
    .prepare('SELECT 1 FROM __drizzle_migrations WHERE created_at = ?')
    .get(fileMeta.folderMillis);
  if (recorded) return;

  raw
    .prepare('INSERT INTO __drizzle_migrations ("hash", "created_at") VALUES (?, ?)')
    .run(fileMeta.hash, fileMeta.folderMillis);
}
