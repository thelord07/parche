/**
 * secrets/scan-path.ts — PARCHE-012.
 *
 * Unidad reutilizada por el backfill de arranque, el comando admin
 * `scan-secrets` y el hook post-push: escanea el head de `(groupId, path)` y
 * reconcilia `secret_findings` (ENMIENDA v2 D2/B3, v3 N1). Nunca lanza — todo
 * error se loguea con `log.warn` y la función retorna sin escribir nada.
 *
 * Nunca ve ni emite el valor de un secreto: solo `kind`/`line`/`fingerprint`
 * de `Finding` (core) viajan por aquí, y de `Finding` solo `kind`+`fingerprint`
 * llegan a la base.
 */
import type { Finding } from '@chamba/core';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { files, secretFindings, secretScanState } from '../db/schema.js';
import type { StoragePort } from '../storage/storage-port.js';
import { SCAN_MAX_BYTES, scanBuffer } from './scan-blob.js';

/** N1 — más allá de este tope, se insertan las primeras N (orden determinista) y NO se cierra nada. */
export const MAX_FINDINGS_PER_PATH = 100;

/** Inserts/updates en lotes para no mandar una sola sentencia gigantesca. */
const CHUNK_SIZE = 200;

export interface ScanPathDeps {
  db: AppDb;
  storage: StoragePort;
  log?: {
    warn(msg: string, obj?: unknown): void;
    info(msg: string, obj?: unknown): void;
  };
}

/** Lee como máximo SCAN_MAX_BYTES + 1 bytes de un Readable — nunca carga un blob entero de 20 MiB. */
async function readBoundedFromStream(
  stream: NodeJS.ReadableStream,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    chunks.push(buf);
    total += buf.length;
    if (total > maxBytes) break;
  }
  return Buffer.concat(chunks);
}

function dedupeByKindFingerprint(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  // `findings` ya viene ordenado por línea asc (scanText) — nos quedamos con la
  // primera ocurrencia de cada (kind, fingerprint), orden determinista.
  for (const f of findings) {
    const key = `${f.kind}\u0000${f.fingerprint}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * B3/N1 — reconcilia `secret_findings` para `(groupId, path)` dado el
 * conjunto actual de hallazgos `F` (ya deduplicado por (kind,fingerprint)).
 * Debe ejecutarse dentro de la MISMA transacción síncrona que hizo el guard
 * de staleness (recibe `tx`, no `db`).
 */
function reconcileFindings(
  tx: AppDb,
  groupId: string,
  path: string,
  hash: string,
  dedupedFindings: Finding[],
  now: string,
  log?: ScanPathDeps['log'],
): void {
  const truncated = dedupedFindings.length > MAX_FINDINGS_PER_PATH;
  const toUpsert = truncated ? dedupedFindings.slice(0, MAX_FINDINGS_PER_PATH) : dedupedFindings;

  for (const batch of chunk(toUpsert, CHUNK_SIZE)) {
    for (const f of batch) {
      tx.insert(secretFindings)
        .values({
          groupId,
          path,
          hash,
          kind: f.kind,
          fingerprint: f.fingerprint,
          foundAt: now,
          resolvedAt: null,
          acknowledgedAt: null,
          acknowledgedBy: null,
        })
        .onConflictDoUpdate({
          target: [
            secretFindings.groupId,
            secretFindings.path,
            secretFindings.kind,
            secretFindings.fingerprint,
          ],
          set: {
            hash,
            resolvedAt: null,
            // Reopen clears ack fields; a finding that was already open keeps its ack.
            acknowledgedAt: sql`CASE WHEN ${secretFindings.resolvedAt} IS NULL THEN ${secretFindings.acknowledgedAt} ELSE NULL END`,
            acknowledgedBy: sql`CASE WHEN ${secretFindings.resolvedAt} IS NULL THEN ${secretFindings.acknowledgedBy} ELSE NULL END`,
          },
        })
        .run();
    }
  }

  if (truncated) {
    log?.info('secret-scan: findings truncated for path', {
      groupId,
      path,
      total: dedupedFindings.length,
    });
    return; // N1 — nunca cerrar hallazgos cuando el conjunto fue truncado.
  }

  // Cerrar las filas abiertas cuyo (kind,fingerprint) ya no está en F.
  const keepKeys = new Set(toUpsert.map((f) => `${f.kind}\u0000${f.fingerprint}`));
  const openRows = tx
    .select({
      id: secretFindings.id,
      kind: secretFindings.kind,
      fingerprint: secretFindings.fingerprint,
    })
    .from(secretFindings)
    .where(
      and(
        eq(secretFindings.groupId, groupId),
        eq(secretFindings.path, path),
        isNull(secretFindings.resolvedAt),
      ),
    )
    .all();
  const idsToClose = openRows
    .filter((r) => !keepKeys.has(`${r.kind}\u0000${r.fingerprint}`))
    .map((r) => r.id);

  for (const batch of chunk(idsToClose, CHUNK_SIZE)) {
    if (batch.length === 0) continue;
    tx.update(secretFindings)
      .set({ resolvedAt: now })
      .where(inArray(secretFindings.id, batch))
      .run();
  }
}

/**
 * Escanea el blob `hash` (head actual de `path`) y reconcilia los hallazgos.
 * Guard de staleness (M2, igual que `updateFileMetaFromBlob`): si `hash` ya no
 * es el head de `(groupId, path)` al entrar a la transacción, no escribe nada.
 */
export async function scanHeadForPath(
  deps: ScanPathDeps,
  groupId: string,
  path: string,
  hash: string,
): Promise<void> {
  try {
    const stream = await deps.storage.get(hash);
    if (!stream) return;
    const buf = await readBoundedFromStream(stream, SCAN_MAX_BYTES + 1);
    const findings = await scanBuffer(buf, path);
    const now = new Date().toISOString();
    const deduped = findings === null ? [] : dedupeByKindFingerprint(findings);

    deps.db.transaction((tx) => {
      const currentFile = tx
        .select({ headHash: files.headHash })
        .from(files)
        .where(and(eq(files.groupId, groupId), eq(files.path, path)))
        .get();

      if (currentFile?.headHash !== hash) return; // stale — otra escritura ya avanzó el head

      reconcileFindings(tx, groupId, path, hash, deduped, now, deps.log);

      tx.insert(secretScanState)
        .values({ groupId, path, hash, scannedAt: now })
        .onConflictDoUpdate({
          target: [secretScanState.groupId, secretScanState.path],
          set: { hash, scannedAt: now },
        })
        .run();
    });
  } catch (err) {
    deps.log?.warn('secret-scan: scanHeadForPath failed', {
      groupId,
      path,
      err: String(err),
    });
  }
}

/** Deps de `resolveAllForPath` — nunca lee ni escribe blobs, así que no necesita `storage`. */
export type ResolveAllForPathDeps = Pick<ScanPathDeps, 'db' | 'log'>;

/**
 * D2/N4 — tombstone (head borrado) o ruta ya no viva: resuelve TODOS los
 * hallazgos abiertos de `(groupId, path)`. El head ya no expone el secreto;
 * nunca se borra la fila, solo UPDATE resolved_at.
 */
export function resolveAllForPath(
  deps: ResolveAllForPathDeps,
  groupId: string,
  path: string,
): void {
  try {
    const now = new Date().toISOString();
    deps.db
      .update(secretFindings)
      .set({ resolvedAt: now })
      .where(
        and(
          eq(secretFindings.groupId, groupId),
          eq(secretFindings.path, path),
          isNull(secretFindings.resolvedAt),
        ),
      )
      .run();
  } catch (err) {
    deps.log?.warn('secret-scan: resolveAllForPath failed', { groupId, path, err: String(err) });
  }
}
