/**
 * Prevents accidental introduction of destructive operations in domain code.
 * Only the cleanupTmp helper in FilesystemStorage may call fs.unlink/rm.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_DIR = new URL('.', import.meta.url).pathname;

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

// Files that are explicitly permitted to contain .delete( calls.
// This list must be empty unless a specific file has a documented exception.
const DELETE_CALL_ALLOWLIST: string[] = [];

describe('no-destructive: domain code must not contain destructive operations', () => {
  it('no DELETE FROM in non-test source files', async () => {
    const files = await collectSourceFiles(SRC_DIR);
    const violations: string[] = [];
    for (const file of files) {
      const content = await readFile(file, 'utf8');
      if (/DELETE\s+FROM/i.test(content)) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });

  it('no .delete( call on any identifier in non-test source files (allowlist must be empty)', async () => {
    // Catches: db.delete(, tx.delete(, liveByKey.delete(, someMap.delete(, drizzle delete(table), etc.
    const files = await collectSourceFiles(SRC_DIR);
    const violations: string[] = [];
    for (const file of files) {
      // Skip files that are explicitly on the allowlist
      if (DELETE_CALL_ALLOWLIST.some((allowed) => file.endsWith(allowed))) continue;
      const content = await readFile(file, 'utf8');
      // Pattern 1: any identifier followed by .delete( — covers Map/Set/drizzle/etc.
      // Pattern 2: bare drizzle delete( with a known table argument
      const hasIdentifierDelete = /\b\w+\.delete\s*\(/.test(content);
      const hasBareDelete =
        /\bdelete\s*\(\s*(groups|users|members|devices|invites|files|changes|blobRefs)\b/.test(
          content,
        );
      if (hasIdentifierDelete || hasBareDelete) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });

  it('no fs.unlink or rm in non-test source files outside filesystem-storage.ts and test-helpers.ts', async () => {
    const files = await collectSourceFiles(SRC_DIR);
    const violations: string[] = [];
    for (const file of files) {
      // filesystem-storage.ts handles blob temp cleanup; test-helpers.ts cleans test dirs
      if (file.includes('filesystem-storage') || file.includes('test-helpers')) continue;
      const content = await readFile(file, 'utf8');
      if (/\b(unlink|rm)\s*\(/.test(content)) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });
});
