import { diffLines } from '@chamba/core';
import { describe, expect, it } from 'vitest';
import { pairLineDiff } from './diff.js';

describe('pairLineDiff', () => {
  it('returns empty array for empty input', () => {
    expect(pairLineDiff('')).toEqual([]);
  });

  it('parses equal lines', () => {
    const result = pairLineDiff('  line1\n  line2\n');
    expect(result).toEqual([
      { kind: 'eq', old: 'line1', new: 'line1' },
      { kind: 'eq', old: 'line2', new: 'line2' },
    ]);
  });

  it('parses add lines', () => {
    const result = pairLineDiff('+ added\n');
    expect(result).toEqual([{ kind: 'add', new: 'added' }]);
  });

  it('parses del lines', () => {
    const result = pairLineDiff('- removed\n');
    expect(result).toEqual([{ kind: 'del', old: 'removed' }]);
  });

  it('collapses - followed by + into mod', () => {
    const result = pairLineDiff('- old line\n+ new line\n');
    expect(result).toEqual([{ kind: 'mod', old: 'old line', new: 'new line' }]);
  });

  it('does not collapse non-adjacent - and +', () => {
    const result = pairLineDiff('- removed\n  context\n+ added\n');
    expect(result).toEqual([
      { kind: 'del', old: 'removed' },
      { kind: 'eq', old: 'context', new: 'context' },
      { kind: 'add', new: 'added' },
    ]);
  });

  it('integrates with core.diffLines', () => {
    const old = 'line1\nline2\nline3\n';
    const newText = 'line1\nchanged\nline3\n';
    const rawDiff = diffLines(old, newText);
    const entries = pairLineDiff(rawDiff);
    expect(entries.some((e) => e.kind === 'mod')).toBe(true);
    expect(entries.some((e) => e.kind === 'eq')).toBe(true);
  });

  // D5: test rename detection is a separate concern in activity endpoint
  // pairLineDiff itself should handle: - line followed by + line = mod
  it('handles multiple mod pairs', () => {
    const diff = '- a\n+ A\n- b\n+ B\n';
    const entries = pairLineDiff(diff);
    expect(entries).toEqual([
      { kind: 'mod', old: 'a', new: 'A' },
      { kind: 'mod', old: 'b', new: 'B' },
    ]);
  });
});
