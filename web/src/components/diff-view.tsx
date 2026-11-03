/** Side-by-side diff view for the Conflicto page.
 *  Left: original (eq + mod.old + del.old highlighted with ~)
 *  Right: copy    (eq + mod.new + add.new highlighted with ~/+)
 */

import type { DiffEntry } from '../api.ts';

export interface PanelLine {
  lineNo: number;
  content: string;
  mark: '' | '~' | '+';
}

export function buildPanels(diff: DiffEntry[]): { left: PanelLine[]; right: PanelLine[] } {
  const left: PanelLine[] = [];
  const right: PanelLine[] = [];
  let leftNo = 1;
  let rightNo = 1;

  for (const entry of diff) {
    if (entry.kind === 'eq') {
      const content = entry.old ?? entry.new ?? '';
      left.push({ lineNo: leftNo++, content, mark: '' });
      right.push({ lineNo: rightNo++, content, mark: '' });
    } else if (entry.kind === 'mod') {
      left.push({ lineNo: leftNo++, content: entry.old ?? '', mark: '~' });
      right.push({ lineNo: rightNo++, content: entry.new ?? '', mark: '~' });
    } else if (entry.kind === 'del') {
      left.push({ lineNo: leftNo++, content: entry.old ?? '', mark: '~' });
    } else if (entry.kind === 'add') {
      right.push({ lineNo: rightNo++, content: entry.new ?? '', mark: '+' });
    }
  }

  return { left, right };
}

interface PanelProps {
  lines: PanelLine[];
}

function DiffPanel({ lines }: PanelProps) {
  return (
    <pre
      style={{
        margin: 0,
        padding: '12px 0',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 13,
        lineHeight: 1.75,
      }}
    >
      <code style={{ display: 'block' }}>
        {lines.map((line) => {
          const isWarn = line.mark === '~';
          const isOk = line.mark === '+';

          return (
            <span
              key={line.lineNo}
              style={{
                display: 'flex',
                padding: '0 16px',
                background: isWarn
                  ? 'oklch(0.83 0.11 88 / 0.1)'
                  : isOk
                    ? 'oklch(0.77 0.11 165 / 0.1)'
                    : undefined,
              }}
            >
              <span
                style={{
                  width: 32,
                  flexShrink: 0,
                  color: 'var(--muted)',
                  userSelect: 'none',
                }}
              >
                {line.lineNo}
              </span>
              <span
                style={{
                  width: 16,
                  flexShrink: 0,
                  color: isWarn ? 'var(--warn-text)' : isOk ? 'var(--ok-text)' : 'transparent',
                  userSelect: 'none',
                }}
              >
                {line.mark || ' '}
              </span>
              {line.content}
            </span>
          );
        })}
      </code>
    </pre>
  );
}

interface DiffViewProps {
  diff: DiffEntry[];
}

export function DiffView({ diff }: DiffViewProps) {
  const { left, right } = buildPanels(diff);

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
      <section
        aria-labelledby="dv-left"
        style={{
          flex: '1 1 440px',
          minWidth: 0,
          border: '1px solid var(--border)',
          borderRadius: 6,
          overflow: 'hidden',
        }}
      >
        <div
          id="dv-left"
          style={{
            padding: '8px 16px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--bg2)',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
            color: 'var(--muted)',
          }}
        >
          Original
        </div>
        <DiffPanel lines={left} />
      </section>

      <section
        aria-labelledby="dv-right"
        style={{
          flex: '1 1 440px',
          minWidth: 0,
          border: '1px solid var(--border)',
          borderRadius: 6,
          overflow: 'hidden',
        }}
      >
        <div
          id="dv-right"
          style={{
            padding: '8px 16px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--bg2)',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
            color: 'var(--muted)',
          }}
        >
          Copia
        </div>
        <DiffPanel lines={right} />
      </section>
    </div>
  );
}
