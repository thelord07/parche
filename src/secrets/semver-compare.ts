/**
 * secrets/semver-compare.ts — PARCHE-013 (review ronda 1 #4, rollback
 * safety; review ronda 2 nit — regex anclada + pre-release conservador).
 *
 * Comparador mínimo de versiones `major.minor.patch[-prerelease]` — sin
 * dependencias nuevas, solo lo que necesita `backfill.ts` para decidir si un
 * cierre es `resolved_reason='rules_update'`. No es un parser semver
 * completo (ignora build metadata `+...`); eso es intencional y suficiente:
 * `@chamba/core` publica `major.minor.patch` simple.
 */

// Ancla en AMBOS extremos (`^...$`): "1.15.1garbage" o "1.15.1.2.3" NO
// parsean — antes, un `^(\d+)\.(\d+)\.(\d+)` sin `$` final los habría
// aceptado leyendo solo el prefijo. El pre-release opcional sigue la forma
// simplificada de semver (`-` seguido de alfanuméricos/puntos/guiones).
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

type Triple = [number, number, number];

interface ParsedVersion {
  triple: Triple;
  isPrerelease: boolean;
}

function parseVersion(version: string | null | undefined): ParsedVersion | null {
  if (!version) return null;
  const match = SEMVER_RE.exec(version);
  if (!match) return null;
  const triple: Triple = [Number(match[1]), Number(match[2]), Number(match[3])];
  return { triple, isPrerelease: match[4] !== undefined };
}

/**
 * `true` solo si `a` es una versión semver válida ESTRICTAMENTE mayor que
 * `b`. `false` si:
 * - cualquiera de las dos no es parseable (incluye `null`, `undefined`,
 *   `'unknown'`, o cualquier string que no sea EXACTAMENTE
 *   `major.minor.patch[-prerelease]`);
 * - cualquiera de las dos es un pre-release (tratado CONSERVADORAMENTE: un
 *   build `-beta`/`-rc` no es una base confiable para decidir "la regla es
 *   nueva" — mejor un cierre normal que requiera ack de más);
 * - son iguales o `a` es menor.
 *
 * Rollback safety (review ronda 1 #4): ante la duda, nunca se trata como
 * "subida de reglas", así que el cierre resultante es normal (pide ack) en
 * vez de `rules_update`.
 */
export function isSemverGreater(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return false;
  if (pa.isPrerelease || pb.isPrerelease) return false;
  for (let i = 0; i < 3; i++) {
    const av = pa.triple[i] as number;
    const bv = pb.triple[i] as number;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false; // iguales
}
