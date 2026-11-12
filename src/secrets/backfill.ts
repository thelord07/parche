import { isScannable } from '@chamba/core';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { files, secretFindings, secretScanState } from '../db/schema.js';
import type { StoragePort } from '../storage/storage-port.js';
import { resolveAllForPath, scanHeadForPath } from './scan-path.js';
import type { SecretScanStatus } from './scan-status.js';

export interface SecretBackfillDeps {
  db: AppDb;
  storage: StoragePort;
  secretScanStatus: SecretScanStatus;
  log?: {
    warn(msg: string, obj?: unknown): void;
    info(msg: string, obj?: unknown): void;
  };
}

const BATCH_SIZE = 500;

/**
 * D3 — todo `isScannable` (`.md .canvas .base .svg`), no solo `.md`.
 * Live heads cuyo secret_scan_state falta o quedó atrás del head actual.
 * Un LEFT JOIN usando los PKs (group_id, path) de ambas tablas — sin N+1.
 */
function findPendingPaths(db: AppDb): Array<{ groupId: string; path: string; hash: string }> {
  const rows = db
    .select({ groupId: files.groupId, path: files.path, headHash: files.headHash })
    .from(files)
    .leftJoin(
      secretScanState,
      and(
        sql`${secretScanState.groupId} = ${files.groupId}`,
        sql`${secretScanState.path} = ${files.path}`,
      ),
    )
    .where(
      and(
        sql`${files.headHash} IS NOT NULL`,
        or(sql`${secretScanState.hash} IS NULL`, sql`${secretScanState.hash} <> ${files.headHash}`),
      ),
    )
    .all();

  return rows
    .filter((r) => r.headHash !== null && isScannable(r.path))
    .map((r) => ({ groupId: r.groupId, path: r.path, hash: r.headHash as string }));
}

/**
 * D2 — rutas con hallazgos abiertos cuyo head actual ya es un tombstone
 * (`files.head_hash IS NULL`). Un secreto resuelto al borrarse la nota.
 */
function findTombstonedWithOpenFindings(db: AppDb): Array<{ groupId: string; path: string }> {
  const rows = db
    .select({ groupId: secretFindings.groupId, path: secretFindings.path })
    .from(secretFindings)
    .innerJoin(
      files,
      and(eq(files.groupId, secretFindings.groupId), eq(files.path, secretFindings.path)),
    )
    .where(and(isNull(secretFindings.resolvedAt), isNull(files.headHash)))
    .all();

  // De-dup: puede haber varios hallazgos abiertos por la misma ruta.
  const seen = new Set<string>();
  const out: Array<{ groupId: string; path: string }> = [];
  for (const r of rows) {
    const key = `${r.groupId}\u0000${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * Corre el escaneo de secretos: resuelve tombstones con hallazgos abiertos y
 * escanea (en lotes de 500, secuencial) todos los heads vivos pendientes.
 * Nunca lanza — actualiza `secretScanStatus.scan` a 'done' incluso en catch.
 */
export async function runSecretScan(deps: SecretBackfillDeps): Promise<void> {
  deps.secretScanStatus.scan = 'running';
  try {
    const tombstoned = findTombstonedWithOpenFindings(deps.db);
    for (const { groupId, path } of tombstoned) {
      resolveAllForPath({ db: deps.db, log: deps.log }, groupId, path);
    }

    const pending = findPendingPaths(deps.db);
    deps.log?.info('secret-scan: processing paths', { count: pending.length });

    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const batch = pending.slice(i, i + BATCH_SIZE);
      for (const { groupId, path, hash } of batch) {
        await scanHeadForPath(
          { db: deps.db, storage: deps.storage, log: deps.log },
          groupId,
          path,
          hash,
        );
      }
      deps.log?.info('secret-scan: progreso', {
        done: Math.min(i + batch.length, pending.length),
        total: pending.length,
      });
    }

    deps.secretScanStatus.scan = 'done';
  } catch (err) {
    deps.log?.warn('secret-scan: failed', { err: String(err) });
    deps.secretScanStatus.scan = 'done';
  }
}

/** Lanza el escaneo en background — no bloquea listen(). Fire-and-forget. */
export function startSecretScanBackground(deps: SecretBackfillDeps): void {
  setImmediate(() => {
    runSecretScan(deps).catch(() => {
      deps.secretScanStatus.scan = 'done';
    });
  });
}
