import { access, cp } from 'node:fs/promises';
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
  external: ['better-sqlite3'],
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
