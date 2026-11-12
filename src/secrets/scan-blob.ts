/**
 * secrets/scan-blob.ts — PARCHE-012.
 *
 * Este módulo nunca recibe ni emite valores de secretos; `Finding` es
 * value-free por construcción en `@chamba/core` (solo expone `kind`, `line`
 * y `fingerprint`). No añade regex propias: todo el matching viene de
 * `scanText`/`matchRules` de core (cotas documentadas, sin backtracking
 * catastrófico).
 */
import type { Finding } from '@chamba/core';
import { scanText } from '@chamba/core';
import { nodeHash } from './node-hash.js';

/** Umbral de escaneo del PUT: independiente de PARCHE_MAX_BLOB_BYTES (20 MiB). */
export const SCAN_MAX_BYTES = 2 * 1024 * 1024;

/** Decodifica `buf` como UTF-8 estricto; `null` si no es UTF-8 válido. */
function decodeUtf8Strict(buf: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/**
 * Escanea `buf` buscando secretos. `reportPath` solo se usa para reportar
 * (se copia a `Finding.path`); no filtra nada ni aparece en ningún log.
 *
 * Devuelve `null` cuando NO se escanea (demasiado grande o no es UTF-8
 * válido) y `Finding[]` (posiblemente vacío) cuando sí se escaneó. Distinguir
 * `null` de `[]` importa para el estado "limpio" del backfill (A3).
 */
export async function scanBuffer(buf: Buffer, reportPath: string): Promise<Finding[] | null> {
  if (buf.length > SCAN_MAX_BYTES) return null;
  const text = decodeUtf8Strict(buf);
  if (text === null) return null;
  return scanText({ hash: nodeHash }, text, reportPath);
}

/** Kinds únicos, ordenados — payload estable del 422/log. */
export function kindsOf(findings: Finding[]): string[] {
  return [...new Set(findings.map((f) => f.kind))].sort();
}
