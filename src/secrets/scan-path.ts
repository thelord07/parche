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
import { isScannable } from '@chamba/core';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { files, secretFindings, secretScanState } from '../db/schema.js';
import type { StoragePort } from '../storage/storage-port.js';
import { SCAN_MAX_BYTES, scanBuffer } from './scan-blob.js';

/**
 * Motivo por el que se cerraron hallazgos en esta reconciliación.
 * `'rules_update'`: el contenido no cambió, pero ya no lo flaguea ninguna
 * regla vigente (PARCHE-013, D2). `undefined`/sin pasar: cierre normal (el
 * head avanzó a un blob sin ese hallazgo, o la ruta es un tombstone).
 */
export type CloseReason = 'rules_update';

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
 *
 * PARCHE-013 (S4.0 corrección 2 / N1): `contentTruncated` es `true` cuando el
 * texto escaneado es solo un PREFIJO del blob real (lectura acotada a
 * `SCAN_MAX_BYTES + 1`, rama lossy de `shouldScanContent` con `gatePath`). Un
 * secreto que viva después del corte no puede marcarse como resuelto, así
 * que — igual que la truncación por cantidad (N1) — se insertan/reabren los
 * hallazgos encontrados en el prefijo pero NUNCA se cierra nada.
 *
 * PARCHE-013 (S4.2 / B2): `closeReason` se escribe SOLO en el UPDATE que
 * cierra filas (nunca en el insert/reopen, que siempre lo limpian a `null`).
 */
function reconcileFindings(
  tx: AppDb,
  groupId: string,
  path: string,
  hash: string,
  dedupedFindings: Finding[],
  now: string,
  contentTruncated: boolean,
  log?: ScanPathDeps['log'],
  closeReason?: CloseReason,
): void {
  const countTruncated = dedupedFindings.length > MAX_FINDINGS_PER_PATH;
  const toUpsert = countTruncated
    ? dedupedFindings.slice(0, MAX_FINDINGS_PER_PATH)
    : dedupedFindings;

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
          resolvedReason: null,
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
            // B2 — un motivo de cierre viejo (p. ej. rules_update) nunca
            // sobrevive a la reapertura: se limpia siempre, igual que resolvedAt.
            resolvedReason: null,
            // Reopen clears ack fields; a finding that was already open keeps its ack.
            acknowledgedAt: sql`CASE WHEN ${secretFindings.resolvedAt} IS NULL THEN ${secretFindings.acknowledgedAt} ELSE NULL END`,
            acknowledgedBy: sql`CASE WHEN ${secretFindings.resolvedAt} IS NULL THEN ${secretFindings.acknowledgedBy} ELSE NULL END`,
          },
        })
        .run();
    }
  }

  if (countTruncated || contentTruncated) {
    log?.info('secret-scan: findings not closed for path (truncated)', {
      groupId,
      path,
      countTruncated,
      contentTruncated,
    });
    return; // N1 / S4.0 corrección 2 — nunca cerrar cuando lo escaneado es parcial.
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
      .set({ resolvedAt: now, resolvedReason: closeReason ?? null })
      .where(inArray(secretFindings.id, batch))
      .run();
  }

  // Review ronda 1 #5 — observabilidad: cuántos hallazgos se cerraron y por
  // qué motivo. Nunca incluye `path` ni ningún valor/fingerprint.
  if (idsToClose.length > 0) {
    log?.info('secret-scan: findings closed', {
      groupId,
      closed: idsToClose.length,
      reason: closeReason ?? 'content_change',
    });
  }
}

/**
 * Escanea el blob `hash` (head actual de `path`) y reconcilia los hallazgos.
 * Guard de staleness (M2, igual que `updateFileMetaFromBlob`): si `hash` ya no
 * es el head de `(groupId, path)` al entrar a la transacción, no escribe nada.
 *
 * PARCHE-013:
 * - `rulesVersion` se graba siempre en `secret_scan_state` (incluso cuando
 *   `findings === null`, S4.0/nit ronda 2) para que esa ruta no se vuelva a
 *   leer en cada arranque solo porque no es escaneable.
 * - Paridad con el cliente (D3/OQ3): si `path` es `isScannable`, se pasa como
 *   `gatePath` a `scanBuffer` (decodificación lossy y sin tope). Combinado
 *   con S4.0 corrección 2 (truncado nunca cierra), esto da cobertura a
 *   `.md`/`.canvas`/`.base`/`.svg` que la rama estricta del servidor se
 *   saltaba hoy, sin arriesgar un cierre a partir de contenido parcial.
 * - `closeReason` se propaga tal cual a `reconcileFindings`: solo el
 *   UPDATE que cierra filas lo escribe (S4.2/B2).
 */
/**
 * Resultado de un intento de `scanHeadForPath` — distingue tres desenlaces
 * (review ronda 2, nit) para que el agregado de `runSecretScan` no confunda
 * "se procesó de verdad" con "el head ya había avanzado bajo nuestros pies":
 * - `'scanned'`: la transacción corrió y escribió (reconcilió hallazgos y/o
 *   `secret_scan_state`), con o sin hallazgos — incluye el caso `findings
 *   === null` (no escaneable: sí se registra `secret_scan_state`, ver B1).
 * - `'stale'`: el head cambió entre que se leyó el blob y se entró a la
 *   transacción; no se escribió nada. Un push concurrente ya ganó — la
 *   ruta probablemente ya quedó cubierta por ese push (hook de
 *   `scanHeadForPath` en `push.ts`) o se re-seleccionará con el head nuevo
 *   en la siguiente página/corrida.
 * - `'failed'`: blob ausente o excepción interna (nunca propaga — se
 *   atrapa y se loguea con `log.warn`, sin valores).
 */
export type ScanOutcome = 'scanned' | 'stale' | 'failed';

export async function scanHeadForPath(
  deps: ScanPathDeps,
  groupId: string,
  path: string,
  hash: string,
  rulesVersion: string,
  closeReason?: CloseReason,
): Promise<ScanOutcome> {
  try {
    const stream = await deps.storage.get(hash);
    if (!stream) {
      // Missing blob — not a bug per se (could be a race with a tombstone),
      // but reported as `'failed'` so the caller's aggregate reflects it;
      // the keyset cursor in backfill.ts still advances past this path
      // regardless, so it never loops.
      deps.log?.warn('secret-scan: blob not found for head', { groupId, path });
      return 'failed';
    }
    const buf = await readBoundedFromStream(stream, SCAN_MAX_BYTES + 1);
    const gatePath = isScannable(path) ? path : undefined;
    const findings = await scanBuffer(buf, path, { gatePath });
    const now = new Date().toISOString();
    const contentTruncated = buf.length > SCAN_MAX_BYTES;

    let stale = false;
    deps.db.transaction((tx) => {
      const currentFile = tx
        .select({ headHash: files.headHash })
        .from(files)
        .where(and(eq(files.groupId, groupId), eq(files.path, path)))
        .get();

      if (currentFile?.headHash !== hash) {
        stale = true;
        return; // stale — otra escritura ya avanzó el head
      }

      const scanStateValues = { groupId, path, hash, rulesVersion, scannedAt: now };

      if (findings === null) {
        // B1 — "no se escaneó" NUNCA equivale a "limpio": no se reconcilia
        // (no se cierra ni se abre nada), pero sí se registra que esta ruta
        // ya se intentó con esta versión de reglas (nit ronda 2) para no
        // releer el blob en cada arranque mientras siga sin ser escaneable.
        tx.insert(secretScanState)
          .values(scanStateValues)
          .onConflictDoUpdate({
            target: [secretScanState.groupId, secretScanState.path],
            set: { hash, rulesVersion, scannedAt: now },
          })
          .run();
        deps.log?.info('secret-scan: not scannable, findings untouched', { groupId, path });
        return;
      }

      const deduped = dedupeByKindFingerprint(findings);
      reconcileFindings(
        tx,
        groupId,
        path,
        hash,
        deduped,
        now,
        contentTruncated,
        deps.log,
        closeReason,
      );

      tx.insert(secretScanState)
        .values(scanStateValues)
        .onConflictDoUpdate({
          target: [secretScanState.groupId, secretScanState.path],
          set: { hash, rulesVersion, scannedAt: now },
        })
        .run();
    });
    return stale ? 'stale' : 'scanned';
  } catch (err) {
    deps.log?.warn('secret-scan: scanHeadForPath failed', {
      groupId,
      path,
      err: String(err),
    });
    return 'failed';
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
      // Review ronda 1 #6 — explícito, igual que el resto del ciclo de vida
      // de B2: un tombstone es un cierre normal (requiere ack), nunca
      // `rules_update`.
      .set({ resolvedAt: now, resolvedReason: null })
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
