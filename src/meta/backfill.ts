import { and, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { fileMeta, files } from '../db/schema.js';
import type { StoragePort } from '../storage/storage-port.js';
import { updateFileMetaFromBlob } from './file-meta.js';
import type { MetaStatus } from './status.js';

export type { MetaStatus };

export interface BackfillDeps {
  db: AppDb;
  storage: StoragePort;
  metaStatus: MetaStatus;
  log?: {
    warn(msg: string, obj?: unknown): void;
    info(msg: string, obj?: unknown): void;
  };
}

/**
 * Find all live .md files whose file_meta is missing or stale (meta.hash !== files.head_hash).
 * Single LEFT JOIN query — avoids N+1 per-file round-trips.
 */
function findPendingFiles(db: AppDb): Array<{ groupId: string; path: string; hash: string }> {
  const rows = db
    .select({
      groupId: files.groupId,
      path: files.path,
      headHash: files.headHash,
    })
    .from(files)
    .leftJoin(
      fileMeta,
      and(sql`${fileMeta.groupId} = ${files.groupId}`, sql`${fileMeta.path} = ${files.path}`),
    )
    .where(
      and(
        isNotNull(files.headHash),
        sql`${files.path} LIKE '%.md'`,
        or(isNull(fileMeta.hash), sql`${fileMeta.hash} <> ${files.headHash}`),
      ),
    )
    .all();

  return rows
    .filter((r) => r.headHash !== null)
    .map((r) => ({ groupId: r.groupId, path: r.path, hash: r.headHash as string }));
}

/**
 * Run backfill: process all live .md files where meta.hash != files.head_hash.
 * Updates metaStatus.backfill. Never throws.
 */
export async function runBackfill(deps: BackfillDeps): Promise<void> {
  deps.metaStatus.backfill = 'running';
  try {
    const pending = findPendingFiles(deps.db);
    deps.log?.info('backfill: processing files', { count: pending.length });
    for (const { groupId, path, hash } of pending) {
      await updateFileMetaFromBlob(
        { db: deps.db, storage: deps.storage, log: deps.log },
        groupId,
        path,
        hash,
      );
    }
    deps.metaStatus.backfill = 'done';
    deps.log?.info('backfill: done', { processed: pending.length });
  } catch (err) {
    deps.log?.warn('backfill: failed', { err: String(err) });
    deps.metaStatus.backfill = 'done';
  }
}

/**
 * Launch backfill in the background — does not block listen().
 * Fire-and-forget: pass a promise handler if you need to track completion.
 */
export function startBackfillBackground(deps: BackfillDeps): void {
  setImmediate(() => {
    runBackfill(deps).catch(() => {
      deps.metaStatus.backfill = 'done';
    });
  });
}
