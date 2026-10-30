import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'web/**/*.test.{ts,tsx}'],
    environmentMatchGlobs: [['web/**', 'jsdom']],
    setupFiles: ['web/vitest.setup.ts'],
  },
});
