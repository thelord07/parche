/**
 * Ensures no local re-definitions of schemas that are exported from @chamba/core.
 * Parche must import these from core, not duplicate them.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_DIR = new URL('.', import.meta.url).pathname;

const CORE_SCHEMA_NAMES = [
  'joinRequestSchema',
  'joinResponseSchema',
  'changesResponseSchema',
  'changeEntrySchema',
  'pushRequestSchema',
  'pushResponseSchema',
  'pushResultSchema',
  'pushChangeSchema',
  'roleSchema',
];

async function collectSourceFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return results;
  for (const entry of entries) {
    const name = entry.name.toString();
    const full = join(dir, name);
    if (entry.isDirectory()) {
      results.push(...(await collectSourceFiles(full)));
    } else if (entry.isFile() && name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      results.push(full);
    }
  }
  return results;
}

describe('no-schema-dup: core schemas must not be re-defined locally', () => {
  for (const schemaName of CORE_SCHEMA_NAMES) {
    it(`no local definition of ${schemaName}`, async () => {
      const files = await collectSourceFiles(SRC_DIR);
      const violations: string[] = [];
      // Pattern: const/export const <name> = z.object or similar definition
      const defPattern = new RegExp(`\\b(const|let|var|export\\s+const)\\s+${schemaName}\\s*=`);
      for (const file of files) {
        const content = await readFile(file, 'utf8');
        if (defPattern.test(content)) {
          violations.push(file);
        }
      }
      expect(violations).toEqual([]);
    });
  }
});
