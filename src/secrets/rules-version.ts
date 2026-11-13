/**
 * secrets/rules-version.ts — PARCHE-013 (D3, review ronda 1 #2).
 *
 * "Versión de reglas" = versión de `@chamba/core` que el proceso en marcha
 * usa de verdad para escanear (`shouldScanContent`/`scanText`), que es la
 * fuente única de verdad del escáner.
 *
 * Dos fuentes, en orden:
 *
 * 1. `__CORE_RULES_VERSION__` — constante inyectada por `tsup.config.ts` en
 *    tiempo de build (`define`), leyendo `node_modules/@chamba/core/package.json`
 *    en ESE momento, con el mismo `node_modules` que esbuild usa para
 *    empaquetar el código de core. Así la versión reportada coincide
 *    exactamente con las reglas que de verdad quedaron embebidas en
 *    `dist/main.js` — no puede desincronizarse de lo que corre en prod. El
 *    `typeof __CORE_RULES_VERSION__ !== 'undefined'` es seguro de evaluar
 *    aunque el identificador no exista en absoluto (comportamiento estándar
 *    de `typeof` sobre un binding no declarado): en dev (`tsx`) y en Vitest,
 *    donde no hay `define` de esbuild, cae directo al fallback de abajo.
 * 2. Fallback en runtime — `require.resolve.paths('@chamba/core')` da la
 *    lista de `node_modules` candidatos (mismo algoritmo de resolución de
 *    Node, pero SIN pasar por el `exports` map del paquete: esa validación
 *    solo se aplica a un subpath, no a listar dónde buscar el paquete; un
 *    `require.resolve('@chamba/core/package.json')` directo daría
 *    `ERR_PACKAGE_PATH_NOT_EXPORTED`, y `import.meta.resolve` no está
 *    implementado por Vitest/vite-node SSR). Se prueba
 *    `<dir>/@chamba/core/package.json` en cada candidato con `existsSync`.
 *
 * Si ambas fallan, el valor es la constante `UNKNOWN_RULES_VERSION` — NUNCA
 * se lanza desde el scope del módulo (haría caer el arranque del servidor
 * por un problema de metadata, no de seguridad). Se avisa por
 * `process.stderr.write` (no `console.*`: `src/no-console-secrets.test.ts`
 * prohíbe `console.*` en todo `secrets/`), sin ruta ni valor — solo el
 * nombre del paquete. `UNKNOWN_RULES_VERSION` nunca es "mayor" que nada en
 * la comparación semver de `backfill.ts` (rollback safety, review ronda 1
 * #4): un cierre con esa versión siempre es un cierre normal, nunca
 * `rules_update`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

declare const __CORE_RULES_VERSION__: string | undefined;

const CORE_PACKAGE_NAME = '@chamba/core';

/** Fallback estable cuando no se pudo determinar la versión instalada. */
export const UNKNOWN_RULES_VERSION = 'unknown';

/** Real runtime lookup — usada por defecto; se puede inyectar otra en tests. */
export function readInstalledCoreVersionAtRuntime(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const searchDirs = require.resolve.paths(CORE_PACKAGE_NAME) ?? [];
    for (const dir of searchDirs) {
      const pkgPath = join(dir, CORE_PACKAGE_NAME, 'package.json');
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
      if (pkg.version) return pkg.version;
    }
  } catch {
    // Degradar al fallback — nunca lanzar desde aquí.
  }
  return null;
}

export interface ComputeRulesVersionOptions {
  /** El valor de `__CORE_RULES_VERSION__` (o `undefined` si no hay define). */
  buildTimeVersion: string | undefined;
  /** Inyectable para tests — por defecto, la lectura real de node_modules. */
  readRuntimeVersion?: () => string | null;
}

/**
 * Lógica pura de resolución — separada de `RULES_VERSION` (que la llama una
 * sola vez al importar el módulo) para poder testear el camino de fallback
 * sin depender de mockear `node:module`/`node:fs` a nivel de proceso.
 */
export function computeRulesVersion(opts: ComputeRulesVersionOptions): string {
  const { buildTimeVersion, readRuntimeVersion = readInstalledCoreVersionAtRuntime } = opts;
  if (buildTimeVersion !== undefined && buildTimeVersion !== UNKNOWN_RULES_VERSION) {
    return buildTimeVersion;
  }
  // Defensivo: incluso si `readRuntimeVersion` (inyectado o el default)
  // lanzara en vez de devolver `null`, esto nunca debe propagar — un
  // problema leyendo metadata de versión no puede tumbar el arranque
  // (review ronda 1 #2).
  let runtime: string | null;
  try {
    runtime = readRuntimeVersion();
  } catch {
    runtime = null;
  }
  if (runtime) return runtime;
  process.stderr.write(
    `rules-version: could not determine the installed ${CORE_PACKAGE_NAME} version; falling back to "${UNKNOWN_RULES_VERSION}" (no rules_update close will happen until this resolves)\n`,
  );
  return UNKNOWN_RULES_VERSION;
}

/**
 * Versión de reglas actual del escáner de secretos. Se calcula una sola vez
 * al importar el módulo (nunca cambia durante la vida del proceso) y NUNCA
 * lanza — en el peor caso vale `UNKNOWN_RULES_VERSION`.
 */
export const RULES_VERSION: string = computeRulesVersion({
  buildTimeVersion:
    typeof __CORE_RULES_VERSION__ === 'undefined' ? undefined : __CORE_RULES_VERSION__,
});
