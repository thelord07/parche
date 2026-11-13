import { existsSync, readFileSync } from 'node:fs';
import { access, cp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { defineConfig } from 'tsup';

/**
 * PARCHE-013 (review ronda 1 #2) — lee la versión de `@chamba/core`
 * instalada EN ESTE build, con el mismo `node_modules` que esbuild usa para
 * empaquetar el código de core, y la inyecta como constante
 * (`__CORE_RULES_VERSION__`, ver `src/secrets/rules-version.ts`) para que
 * `/health.secretScan.rulesVersion` refleje exactamente lo que quedó
 * embebido en `dist/main.js` — no lo que el `node_modules` del contenedor
 * en runtime diga, que en teoría podría diferir. `require.resolve.paths`
 * evita el `exports` map de core (que no expone `package.json`), igual que
 * el fallback en runtime de `rules-version.ts`. Nunca lanza: si no se puede
 * determinar, el string embebido es `'unknown'` y `rules-version.ts` cae a
 * su propio fallback de runtime.
 */
function readCoreVersionAtBuildTime(): string {
  const CORE_PACKAGE_NAME = '@chamba/core';
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
    // fall through — 'unknown' hace que rules-version.ts use su propio fallback.
  }
  return 'unknown';
}

export default defineConfig({
  entry: {
    main: 'src/main.ts',
    'admin-cli': 'src/admin/cli.ts',
  },
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  shims: false,
  external: ['better-sqlite3'],
  define: {
    __CORE_RULES_VERSION__: JSON.stringify(readCoreVersionAtBuildTime()),
  },
  async onSuccess() {
    // Copy migration files
    try {
      await cp('src/db/migrations', 'dist/migrations', { recursive: true });
    } catch {
      // Migrations directory may not exist yet
    }

    // Copy SPA build — fail loudly if missing
    try {
      await access('web/dist');
    } catch {
      console.error('[tsup] ERROR: web/dist is missing. Run "pnpm run build:web" first.');
      process.exit(1);
    }
    await cp('web/dist', 'dist/web', { recursive: true });
  },
});
