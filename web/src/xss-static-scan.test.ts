/**
 * O1: Static XSS guardrail
 *
 * Ensures that `dangerouslySetInnerHTML` appears ONLY in `note-article.tsx`.
 * Any other component using it bypasses the SanitizedHtml branded-type gate
 * and must be blocked by this test.
 *
 * Also checks that api.ts is the ONLY source of SanitizedHtml (i.e. it's not
 * cast or forged elsewhere in web/src).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB_SRC = join(__dirname);

function walkTsxFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...walkTsxFiles(full));
    } else if (entry.endsWith('.tsx') || entry.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

function readFile(p: string): string {
  return readFileSync(p, 'utf8');
}

// Pure helper — extracted so it can be unit-tested in isolation
function isDangerouslySetInnerHtmlAllowed(relPath: string): boolean {
  return relPath === 'components/note-article.tsx';
}

describe('O1: dangerouslySetInnerHTML guardrail', () => {
  it('isDangerouslySetInnerHtmlAllowed: allows only the exact relative path', () => {
    // Correct file
    expect(isDangerouslySetInnerHtmlAllowed('components/note-article.tsx')).toBe(true);
    // Same basename in a different directory must be rejected
    expect(isDangerouslySetInnerHtmlAllowed('pages/note-article.tsx')).toBe(false);
    expect(isDangerouslySetInnerHtmlAllowed('note-article.tsx')).toBe(false);
    expect(isDangerouslySetInnerHtmlAllowed('other/components/note-article.tsx')).toBe(false);
  });

  it('dangerouslySetInnerHTML appears ONLY in note-article.tsx (or nowhere if not yet created)', () => {
    const files = walkTsxFiles(WEB_SRC);
    const violations: string[] = [];

    for (const file of files) {
      const rel = relative(WEB_SRC, file);
      // Skip test files
      if (rel.includes('.test.')) continue;
      const content = readFile(file);
      if (content.includes('dangerouslySetInnerHTML')) {
        // Only components/note-article.tsx is allowed — checked by relative path,
        // not basename, so a same-named file in a different directory is also caught.
        if (rel !== 'components/note-article.tsx') {
          violations.push(rel);
        }
      }
    }

    expect(
      violations,
      `dangerouslySetInnerHTML found outside note-article.tsx: ${violations.join(', ')}`,
    ).toEqual([]);
  });

  it('SanitizedHtml type is not cast/forged outside api.ts', () => {
    const files = walkTsxFiles(WEB_SRC);
    const violations: string[] = [];

    for (const file of files) {
      const rel = relative(WEB_SRC, file);
      // Skip test files and api.ts itself
      if (rel.includes('.test.') || rel === 'api.ts') continue;
      const content = readFile(file);
      // Look for `as SanitizedHtml` casts outside of api.ts
      if (/as SanitizedHtml\b/.test(content)) {
        violations.push(rel);
      }
    }

    expect(violations, `SanitizedHtml forged outside api.ts: ${violations.join(', ')}`).toEqual([]);
  });
});
