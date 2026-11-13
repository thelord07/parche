import { isScannable } from '@chamba/core';
import { and, eq, isNull, like, or, sql } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { files, secretFindings, secretScanState } from '../db/schema.js';
import type { StoragePort } from '../storage/storage-port.js';
import { RULES_VERSION } from './rules-version.js';
import type { CloseReason } from './scan-path.js';
import { resolveAllForPath, scanHeadForPath } from './scan-path.js';
import type { SecretScanStatus } from './scan-status.js';
import { isSemverGreater } from './semver-compare.js';

export interface SecretBackfillDeps {
  db: AppDb;
  storage: StoragePort;
  secretScanStatus: SecretScanStatus;
  log?: {
    warn(msg: string, obj?: unknown): void;
    info(msg: string, obj?: unknown): void;
  };
}

/**
 * Lotes de 500 — tanto para la paginación por keyset como para el log de
 * progreso. Exportada solo para que los tests puedan sembrar
 * `BATCH_SIZE + k` rutas sin hardcodear el número (review ronda 2 #2).
 */
export const BATCH_SIZE = 500;

interface PendingRow {
  groupId: string;
  path: string;
  headHash: string | null;
  scanHash: string | null;
  scanRulesVersion: string | null;
}

interface PendingPath {
  groupId: string;
  path: string;
  hash: string;
  /** B2 — solo cuando el hash no cambió, la versión subió (semver) y la regla ya no aplica. */
  closeReason?: CloseReason;
}

interface Cursor {
  groupId: string;
  path: string;
}

/**
 * Review ronda 2 (#1) — mirror SQL de `isScannable` de `@chamba/core`
 * (`.md`/`.canvas`/`.base`/`.svg`, verificado contra el paquete instalado:
 * sufijo de extensión, case-insensitive). `LIKE` en SQLite ya es
 * case-insensitive para ASCII por defecto, así que no hace falta `LOWER()`.
 * Sin este filtro a nivel SQL, una ruta `isScannable`-false (p. ej. `.png`)
 * nunca obtiene una fila en `secret_scan_state` y por lo tanto nunca sale
 * de `pendingCondition` — quedaría "pendiente" para siempre, inflando
 * `secretScanStatus.pending` y reconsultándose en cada página/arranque sin
 * que `runSecretScan` pueda hacer nada con ella (se descarta en JS). El
 * filtro JS (`isScannable`) en el `.filter()` de más abajo se mantiene
 * como defensa en profundidad, no como la única barrera.
 */
function isScannablePathCondition() {
  return or(
    like(files.path, '%.md'),
    like(files.path, '%.canvas'),
    like(files.path, '%.base'),
    like(files.path, '%.svg'),
  );
}

/**
 * D3 — condición común: live heads, con extensión escaneable (arriba), cuyo
 * `secret_scan_state` falta, quedó atrás del head actual, o fue escaneado
 * con una versión de reglas distinta de la instalada (PARCHE-013): esto
 * hace que las reglas nuevas (p. ej. Stripe) se apliquen también a archivos
 * ya escaneados y limpios, no solo a los que tienen hallazgos abiertos —
 * sin reescanear el vault entero en cada arranque: una vez escaneada con la
 * versión actual, la ruta sale del conjunto hasta la próxima subida de
 * versión.
 */
function pendingCondition(rulesVersion: string) {
  return and(
    sql`${files.headHash} IS NOT NULL`,
    isScannablePathCondition(),
    or(
      sql`${secretScanState.hash} IS NULL`,
      sql`${secretScanState.hash} <> ${files.headHash}`,
      sql`${secretScanState.rulesVersion} IS NULL`,
      sql`${secretScanState.rulesVersion} <> ${rulesVersion}`,
    ),
  );
}

/**
 * Cuenta las rutas pendientes — solo para `secretScanStatus.pending`
 * (observabilidad en `/health`), no para la selección real. Usa el mismo
 * LEFT JOIN por los PKs (group_id, path) de ambas tablas, sin índice nuevo.
 *
 * Review ronda 2 (#1) — se llama UNA SOLA VEZ por corrida, antes del bucle
 * de páginas (nunca dentro de él): antes, se re-ejecutaba por página
 * (O(páginas) full-ish scans de `files` por arranque); ahora el progreso
 * durante el bucle se deriva en memoria (`total - scanned - stale -
 * failed`), sin volver a tocar la base de datos.
 */
function countPendingPaths(db: AppDb, rulesVersion: string): number {
  const row = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(files)
    .leftJoin(
      secretScanState,
      and(
        sql`${secretScanState.groupId} = ${files.groupId}`,
        sql`${secretScanState.path} = ${files.path}`,
      ),
    )
    .where(pendingCondition(rulesVersion))
    .get();
  return row?.count ?? 0;
}

/**
 * Review ronda 1 (#3) — paginación por keyset `(group_id, path)` en vez de
 * materializar el conjunto pendiente completo. Cada página se re-consulta
 * con `LIMIT BATCH_SIZE` y un cursor `(group_id, path) > after`, así que:
 * - el costo de memoria por corrida es O(BATCH_SIZE), no O(pendientes);
 * - es reanudable entre arranques (cada ruta sale del conjunto en cuanto
 *   `secret_scan_state` registra su hash/versión actuales);
 * - una ruta que NO se pueda escanear (blob ausente, error interno — nunca
 *   lanza, `scanHeadForPath` siempre resuelve) no vuelve a aparecer en la
 *   MISMA corrida: el cursor avanza al final de la página sin importar si
 *   cada fila se procesó con éxito, así que nunca hay un bucle infinito
 *   dentro de un `runSecretScan`. Si de verdad no se pudo escanear, sigue
 *   pendiente para el PRÓXIMO arranque (su `secret_scan_state` no avanzó).
 */
/**
 * Review ronda 1 (#7) — separada de `fetchPendingBatch` para que un test
 * pueda inspeccionar el SQL REAL (`.toSQL()`) de la query que de verdad
 * ejecuta `runSecretScan`, en vez de una copia a mano que podría divergir.
 * Exportada solo para eso.
 */
export function buildPendingBatchQuery(db: AppDb, rulesVersion: string, after: Cursor | null) {
  const keysetCond = after
    ? sql`(${files.groupId} > ${after.groupId} OR (${files.groupId} = ${after.groupId} AND ${files.path} > ${after.path}))`
    : sql`1 = 1`;

  return db
    .select({
      groupId: files.groupId,
      path: files.path,
      headHash: files.headHash,
      scanHash: secretScanState.hash,
      scanRulesVersion: secretScanState.rulesVersion,
    })
    .from(files)
    .leftJoin(
      secretScanState,
      and(
        sql`${secretScanState.groupId} = ${files.groupId}`,
        sql`${secretScanState.path} = ${files.path}`,
      ),
    )
    .where(and(pendingCondition(rulesVersion), keysetCond))
    .orderBy(files.groupId, files.path)
    .limit(BATCH_SIZE);
}

function fetchPendingBatch(db: AppDb, rulesVersion: string, after: Cursor | null): PendingRow[] {
  return buildPendingBatchQuery(db, rulesVersion, after).all();
}

/**
 * Review ronda 1 (#4) — rollback safety: `rules_update` SOLO si el hash no
 * cambió Y la versión instalada es ESTRICTAMENTE MAYOR (semver) que la
 * registrada. Si la instalada es igual, menor, o cualquiera de las dos no es
 * parseable (incluye `'unknown'`), el cierre —si lo hay— es normal (pide
 * ack): un rollback de `@chamba/core` nunca inventa cierres de "regla
 * nueva".
 */
function toPendingPath(row: PendingRow, rulesVersion: string): PendingPath {
  const hashChanged = row.scanHash === null || row.scanHash !== row.headHash;
  const rulesChanged = row.scanRulesVersion === null || row.scanRulesVersion !== rulesVersion;
  const closeReason: CloseReason | undefined =
    !hashChanged && rulesChanged && isSemverGreater(rulesVersion, row.scanRulesVersion)
      ? 'rules_update'
      : undefined;
  return { groupId: row.groupId, path: row.path, hash: row.headHash as string, closeReason };
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
 * escanea (en páginas de 500 por keyset, secuencial) todos los heads vivos
 * pendientes — por cambio de contenido o por cambio de versión de reglas
 * (PARCHE-013, D3). Nunca lanza — actualiza `secretScanStatus.scan` a
 * 'done' incluso en catch. Es idempotente y reanudable: si el proceso cae a
 * mitad de camino, la próxima corrida retoma exactamente las rutas que
 * falten (cada ruta sale del conjunto pendiente en cuanto `secret_scan_state`
 * registra su hash y su `rulesVersion` actuales).
 */
export async function runSecretScan(deps: SecretBackfillDeps): Promise<void> {
  deps.secretScanStatus.scan = 'running';
  deps.secretScanStatus.rulesVersion = RULES_VERSION;
  let scanned = 0;
  let stale = 0;
  let failed = 0;
  const runStartedAt = new Date().toISOString();
  try {
    const tombstoned = findTombstonedWithOpenFindings(deps.db);
    for (const { groupId, path } of tombstoned) {
      resolveAllForPath({ db: deps.db, log: deps.log }, groupId, path);
    }

    // Review ronda 2 (#1) — UNA sola query de conteo para TODA la corrida,
    // antes del bucle de páginas. El progreso durante el bucle se deriva en
    // memoria (ver más abajo), nunca se vuelve a consultar la base para
    // "pending". `pendingCondition` ya filtra por extensión escaneable en
    // SQL, así que este total no incluye rutas que nunca se van a procesar
    // (p. ej. `.png`) — de lo contrario quedarían "pendientes" para siempre.
    const totalPending = countPendingPaths(deps.db, RULES_VERSION);
    deps.secretScanStatus.pending = totalPending;
    deps.secretScanStatus.scanned = 0;
    deps.log?.info('secret-scan: processing paths', {
      count: totalPending,
      rulesVersion: RULES_VERSION,
    });

    let cursor: Cursor | null = null;
    for (;;) {
      const rawBatch = fetchPendingBatch(deps.db, RULES_VERSION, cursor);
      if (rawBatch.length === 0) break;

      // El cursor avanza al final de ESTA página sin importar el resultado
      // por fila (ver docstring de fetchPendingBatch) — nunca un bucle
      // infinito dentro de esta corrida.
      const lastRow = rawBatch[rawBatch.length - 1] as PendingRow;
      cursor = { groupId: lastRow.groupId, path: lastRow.path };

      // Defensa en profundidad (review ronda 2 #1): `pendingCondition` ya
      // filtra por extensión en SQL; este `.filter(isScannable)` cubre el
      // caso de que algún día el patrón SQL y `isScannable` diverjan.
      const batch = rawBatch
        .filter((r) => r.headHash !== null && isScannable(r.path))
        .map((r) => toPendingPath(r, RULES_VERSION));

      for (const { groupId, path, hash, closeReason } of batch) {
        const outcome = await scanHeadForPath(
          { db: deps.db, storage: deps.storage, log: deps.log },
          groupId,
          path,
          hash,
          RULES_VERSION,
          closeReason,
        );
        // 'stale' NO cuenta como escaneado (nit ronda 2): la transacción no
        // escribió nada, así que la ruta sigue genuinamente pendiente desde
        // el punto de vista de los datos — solo deja de aparecer en ESTA
        // corrida porque el cursor ya avanzó más allá de su clave.
        if (outcome === 'scanned') scanned++;
        else if (outcome === 'stale') stale++;
        else failed++;
      }
      deps.secretScanStatus.scanned = scanned;
      // Progreso derivado en memoria — nunca una query nueva por página.
      deps.secretScanStatus.pending = Math.max(0, totalPending - scanned - stale - failed);
      deps.log?.info('secret-scan: progreso', { scanned, stale, failed });
    }

    // Review ronda 1 #5 — agregado de la corrida completa. `closedByRulesUpdate`
    // se mide por delta (filas cerradas con ese motivo desde que empezó esta
    // corrida) en vez de contarlas una a una en el hot path. Nota: si
    // `runSecretScan` corriera dos veces en paralelo (arranque + `pnpm admin
    // scan-secrets`, ver supuesto 9 del plan), este delta podría incluir
    // cierres hechos por la OTRA corrida solapada, no solo por esta — el
    // número es un agregado observacional para logs, no una garantía de
    // atribución exacta por corrida.
    const closedByRulesUpdateRow = deps.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(secretFindings)
      .where(
        and(
          eq(secretFindings.resolvedReason, 'rules_update'),
          sql`${secretFindings.resolvedAt} >= ${runStartedAt}`,
        ),
      )
      .get();
    deps.log?.info('secret-scan: run summary', {
      scanned,
      stale,
      failed,
      closedByRulesUpdate: closedByRulesUpdateRow?.count ?? 0,
    });

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
