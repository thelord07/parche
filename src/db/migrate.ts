import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { RawDb } from './client.js';

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
  migrate(db, { migrationsFolder });
}
