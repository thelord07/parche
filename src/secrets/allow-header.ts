/**
 * secrets/allow-header.ts — PARCHE-012.
 *
 * Parsea `X-Parche-Secret-Allow: <fingerprint>,<fingerprint>,…`. Nunca
 * rechaza con 400: una cabecera basura simplemente no exime nada.
 *
 * R3 (documentado, needs-approval): el servidor solo conoce fingerprints
 * (no rutas), así que compara SOLO por fingerprint — un fingerprint eximido
 * para una nota exime ese mismo valor en cualquier ruta del mismo request.
 * Semántica más laxa que la del cliente, que exime por (ruta, fingerprint).
 */

const MAX_HEADER_BYTES = 2 * 1024;
const MAX_ENTRIES = 64;
const FINGERPRINT_RE = /^[0-9a-f]{12}$/;

/** Parsea la cabecera de allowlist. Devuelve el set de fingerprints eximidos. */
export function parseAllowHeader(raw: string | string[] | undefined): Set<string> {
  if (raw === undefined) return new Set();
  const value = Array.isArray(raw) ? raw.join(',') : raw;
  if (Buffer.byteLength(value, 'utf8') > MAX_HEADER_BYTES) return new Set();

  const allowed = new Set<string>();
  for (const entry of value.split(',').slice(0, MAX_ENTRIES)) {
    const trimmed = entry.trim();
    if (FINGERPRINT_RE.test(trimmed)) {
      allowed.add(trimmed);
    }
  }
  return allowed;
}
