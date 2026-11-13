/**
 * secrets/scan-blob.ts — PARCHE-012 / PARCHE-013.
 *
 * Este módulo nunca recibe ni emite valores de secretos; `Finding` es
 * value-free por construcción en `@chamba/core` (solo expone `kind`, `line`
 * y `fingerprint`). No añade regex propias: todo el matching viene de
 * `scanText`/`matchRules` de core (cotas documentadas, sin backtracking
 * catastrófico).
 *
 * PARCHE-013: la decisión de QUÉ escanear (criterio de decodificación/tope)
 * ya no vive aquí — se delega por completo a `shouldScanContent` de
 * `@chamba/core`, la misma función que usa el cliente chamba. Esto evita que
 * servidor y cliente diverjan en su criterio de "qué se escanea".
 */
import type { Finding } from '@chamba/core';
import { MAX_SCAN_BYTES, scanText, shouldScanContent } from '@chamba/core';
import { nodeHash } from './node-hash.js';

/** Re-exportado de core — mismo umbral que usa el cliente (2 MiB). */
export const SCAN_MAX_BYTES = MAX_SCAN_BYTES;

/**
 * Tope de hallazgos devueltos en el body del 422 de `PUT /api/blob/:hash`.
 * Constante LOCAL (no se importa de `scan-path.ts`): `scan-path.ts` ya
 * importa `SCAN_MAX_BYTES`/`scanBuffer` de este módulo (ver su cabecera), así
 * que un import en sentido inverso crearía un ciclo. Replica el mismo patrón
 * que `MAX_FINDINGS_PER_PATH` de `scan-path.ts` (ese es el precedente), solo
 * que para la respuesta HTTP en vez de para lo que se persiste por ruta.
 */
export const MAX_FINDINGS_IN_RESPONSE = 100;

export interface ScanBufferOptions {
  /**
   * Ruta usada SOLO para decidir el criterio de decodificación de
   * `shouldScanContent` (paridad con el cliente: lossy y sin tope para
   * `.md/.canvas/.base/.svg`). `PUT /api/blob/:hash` no tiene ruta y nunca
   * pasa esto — queda en la rama estricta (UTF-8 + `MAX_SCAN_BYTES`). El
   * backfill/hook de push sí la pasa (ver `scan-path.ts`).
   */
  gatePath?: string;
}

/**
 * Escanea `buf` buscando secretos. `reportPath` solo se usa para reportar
 * (se copia a `Finding.path`); no filtra nada ni aparece en ningún log.
 *
 * `shouldScanContent` decide si se escanea y devuelve el texto ya decodificado
 * (o `null` si no corresponde escanear). Ese texto se usa tal cual, sin
 * volver a decodificar. Dos ramas según `opts.gatePath`:
 *
 * - SIN `gatePath` (rama estricta — el caso de `PUT /api/blob/:hash`, que no
 *   tiene ruta): UTF-8 estricto y `≤ MAX_SCAN_BYTES`. Devuelve `null` si el
 *   buffer no es UTF-8 válido o excede el tope.
 * - CON `gatePath` de una extensión `isScannable` (`.md`/`.canvas`/`.base`/
 *   `.svg` — el caso del backfill/hook de push, ver `scan-path.ts`): decode
 *   LOSSY y SIN tope, paridad con el criterio 1.15.0 del cliente. Esta rama
 *   **nunca devuelve `null`** — toda secuencia de bytes decodifica lossily a
 *   *algo* — así que un `.md` binario o > `SCAN_MAX_BYTES` SÍ se escanea
 *   (el `buf` que llega aquí ya viene acotado por la lectura del caller, no
 *   por esta función; ver "contentTruncated" en `scan-path.ts` para por qué
 *   eso nunca cierra hallazgos a partir de un prefijo).
 *
 * Devuelve `null` cuando NO se escanea (solo posible en la rama estricta) y
 * `Finding[]` (posiblemente vacío) cuando sí se escaneó. Distinguir `null`
 * de `[]` importa para el estado "limpio" del backfill (A3): `null` nunca
 * debe tratarse como "sin hallazgos".
 */
export async function scanBuffer(
  buf: Buffer,
  reportPath: string,
  opts: ScanBufferOptions = {},
): Promise<Finding[] | null> {
  const text = shouldScanContent(buf, opts.gatePath);
  if (text === null) return null;
  return scanText({ hash: nodeHash }, text, reportPath);
}

/** Kinds únicos, ordenados — payload estable del 422/log. Sin tope (A9). */
export function kindsOf(findings: Finding[]): string[] {
  return [...new Set(findings.map((f) => f.kind))].sort();
}

export interface FindingPayloadItem {
  kind: string;
  fingerprint: string;
}

/**
 * Proyección `{kind, fingerprint}` para el body del 422 — PARCHE-013.
 * Nunca `...f`: `Finding` trae también `line` y `path`, prohibidos en la
 * respuesta.
 *
 * - deduplica por `(kind, fingerprint)`;
 * - prioriza las NO exentas: cuando el tope recorta, lo que sobrevive es lo
 *   que el usuario todavía tiene que eximir (eximir progresa en vez de
 *   estancarse mostrando siempre las mismas ya exentas). Dentro de cada
 *   grupo (exento/no exento), orden determinista por `kind` asc y luego
 *   `fingerprint` asc;
 * - tope de `MAX_FINDINGS_IN_RESPONSE` (100) entradas. `kinds` (arriba) no
 *   lleva tope — asimetría intencional, documentada en README: `kinds` está
 *   acotado por el catálogo de reglas, `findings` escala con el contenido.
 */
export function findingsPayload(findings: Finding[], allowed: Set<string>): FindingPayloadItem[] {
  const seen = new Set<string>();
  const deduped: Finding[] = [];
  for (const f of findings) {
    const key = `${f.kind}\u0000${f.fingerprint}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(f);
  }

  deduped.sort((a, b) => {
    const aExempt = allowed.has(a.fingerprint);
    const bExempt = allowed.has(b.fingerprint);
    if (aExempt !== bExempt) return aExempt ? 1 : -1; // no exentas primero
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    if (a.fingerprint !== b.fingerprint) return a.fingerprint < b.fingerprint ? -1 : 1;
    return 0;
  });

  return deduped.slice(0, MAX_FINDINGS_IN_RESPONSE).map((f) => ({
    kind: f.kind,
    fingerprint: f.fingerprint,
  }));
}
