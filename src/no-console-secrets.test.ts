/**
 * AC4 guard: tokens, session secrets and invite codes must never reach stdout.
 *
 * The request-level test in `routes/web/auth.secrets.test.ts` captures pino and
 * `process.stdout.write`, but vitest intercepts `console.*` before stdout, so a
 * stray `console.log(token)` would slip through it. This test closes that gap by
 * forbidding `console.*` in every module that handles those secrets. Server
 * output goes through pino (with redaction) only.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_DIR = new URL('.', import.meta.url).pathname;

// Directories whose code touches magic-link tokens, session secrets or invite codes.
const SECRET_HANDLING_DIRS = ['auth', 'mail', 'routes', 'admin'];

// Must stay empty. `admin/cli.ts` prints the owner token / invite code once by design
// (PARCHE-003), but through `process.stdout.write`, not `console.*`.
const ALLOWLIST: string[] = [];

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

describe('no-console-secrets', () => {
  it('no console.* call in modules that handle tokens, sessions or invite codes', async () => {
    const violations: string[] = [];
    for (const dir of SECRET_HANDLING_DIRS) {
      for (const file of await collectSourceFiles(join(SRC_DIR, dir))) {
        if (ALLOWLIST.some((allowed) => file.endsWith(allowed))) continue;
        const content = await readFile(file, 'utf8');
        if (/\bconsole\s*\.\s*(log|info|warn|error|debug|trace)\s*\(/.test(content)) {
          violations.push(file);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
