import { cp } from 'node:fs/promises';
import { defineConfig } from 'tsup';

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
  // better-sqlite3 is a native CJS module — must stay external so tsup does not attempt
  // to bundle the binding, which would break at runtime.
  external: ['better-sqlite3'],
  async onSuccess() {
    // Copy versionned migration SQL files alongside the bundle so that
    // fileURLToPath(new URL('./migrations', import.meta.url)) resolves correctly
    // from dist/main.js and dist/admin-cli.js at runtime.
    try {
      await cp('src/db/migrations', 'dist/migrations', { recursive: true });
    } catch {
      // Migrations directory may not exist yet during first bootstrapping
    }
  },
});
