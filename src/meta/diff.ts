import { diffLines } from '@chamba/core';

export { diffLines };

export interface DiffEntry {
  kind: 'eq' | 'mod' | 'add' | 'del';
  old?: string;
  new?: string;
}

/**
 * Parse diffLines output (lines prefixed '  ', '- ', '+ ') into structured entries.
 * Consecutive '- ' followed by '+ ' collapses into 'mod' (~).
 */
export function pairLineDiff(diffOutput: string): DiffEntry[] {
  if (!diffOutput) return [];
  const lines = diffOutput.split('\n');
  // Remove trailing empty line if present
  if (lines[lines.length - 1] === '') lines.pop();

  const result: DiffEntry[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.startsWith('  ')) {
      result.push({ kind: 'eq', old: line.slice(2), new: line.slice(2) });
      i++;
    } else if (line.startsWith('- ')) {
      // Peek: if next is '+ ', collapse to mod
      const next = lines[i + 1] ?? '';
      if (next.startsWith('+ ')) {
        result.push({ kind: 'mod', old: line.slice(2), new: next.slice(2) });
        i += 2;
      } else {
        result.push({ kind: 'del', old: line.slice(2) });
        i++;
      }
    } else if (line.startsWith('+ ')) {
      result.push({ kind: 'add', new: line.slice(2) });
      i++;
    } else {
      // Unknown prefix — skip
      i++;
    }
  }
  return result;
}
