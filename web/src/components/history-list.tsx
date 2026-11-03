/** Version history panel for a note.
 *  Actions: Ver versión (shows raw content in <pre>), Diff contra la actual.
 *  NO "Restaurar" action — that is Entrega C.
 */

import { useEffect, useRef, useState } from 'react';
import { api, type DiffEntry, type NoteVersion } from '../api.ts';
import { timeAgo } from '../lib/time.ts';

interface HistoryListProps {
  slug: string;
  path: string;
  versions: NoteVersion[];
  headSeq: number;
}

type PanelState =
  | { kind: 'none' }
  | { kind: 'loading' }
  | { kind: 'error'; msg: string }
  | { kind: 'version'; seq: number; content: string }
  | { kind: 'diff'; from: number; to: number; diff: DiffEntry[] };

function DiffLines({ diff }: { diff: DiffEntry[] }) {
  return (
    <pre
      style={{
        margin: 0,
        padding: '12px 0',
        overflow: 'auto',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 13,
        lineHeight: 1.75,
      }}
    >
      <code style={{ display: 'block' }}>
        {diff.map((entry, diffIdx) => {
          const lineKey = `${diffIdx}-${entry.kind}`;
          if (entry.kind === 'eq') {
            return (
              <span key={lineKey} style={{ display: 'flex', padding: '0 12px' }}>
                <span style={{ width: 16, flexShrink: 0 }}> </span>
                {entry.old ?? entry.new}
              </span>
            );
          }
          if (entry.kind === 'mod') {
            return (
              <span key={lineKey}>
                <span
                  style={{
                    display: 'flex',
                    padding: '0 12px',
                    background: 'oklch(0.83 0.11 88 / 0.1)',
                  }}
                >
                  <span style={{ width: 16, flexShrink: 0, color: 'var(--warn-text)' }}>~</span>
                  <span style={{ textDecoration: 'line-through', color: 'var(--muted)' }}>
                    {entry.old}
                  </span>
                </span>
                <span
                  style={{
                    display: 'flex',
                    padding: '0 12px',
                    background: 'oklch(0.83 0.11 88 / 0.06)',
                  }}
                >
                  <span style={{ width: 16, flexShrink: 0, color: 'var(--warn-text)' }}>~</span>
                  {entry.new}
                </span>
              </span>
            );
          }
          if (entry.kind === 'add') {
            return (
              <span
                key={lineKey}
                style={{
                  display: 'flex',
                  padding: '0 12px',
                  background: 'oklch(0.77 0.11 165 / 0.1)',
                }}
              >
                <span style={{ width: 16, flexShrink: 0, color: 'var(--ok-text)' }}>+</span>
                {entry.new}
              </span>
            );
          }
          // del
          return (
            <span
              key={lineKey}
              style={{
                display: 'flex',
                padding: '0 12px',
                background: 'oklch(0.83 0.11 88 / 0.08)',
              }}
            >
              <span style={{ width: 16, flexShrink: 0, color: 'var(--warn-text)' }}>−</span>
              <span style={{ textDecoration: 'line-through', color: 'var(--muted)' }}>
                {entry.old}
              </span>
            </span>
          );
        })}
      </code>
    </pre>
  );
}

export function HistoryList({ slug, path, versions, headSeq }: HistoryListProps) {
  const [panel, setPanel] = useState<PanelState>({ kind: 'none' });
  const panelHeadingRef = useRef<HTMLSpanElement>(null);
  const panelContainerRef = useRef<HTMLDivElement>(null);

  // When a panel becomes ready (non-loading, non-none), scroll it into view and
  // move focus to its heading so screen readers announce the new content.
  useEffect(() => {
    if (panel.kind === 'none' || panel.kind === 'loading') return;
    panelContainerRef.current?.scrollIntoView?.({ block: 'nearest' });
    panelHeadingRef.current?.focus();
  }, [panel.kind, panel]);

  async function handleViewVersion(seq: number) {
    setPanel({ kind: 'loading' });
    try {
      const r = await api.getNoteVersion(slug, path, seq);
      setPanel({ kind: 'version', seq, content: r.content });
    } catch {
      setPanel({ kind: 'error', msg: 'No se pudo cargar la versión.' });
    }
  }

  async function handleDiff(from: number) {
    setPanel({ kind: 'loading' });
    try {
      const r = await api.getDiff(slug, path, from, headSeq);
      setPanel({ kind: 'diff', from, to: headSeq, diff: r.diff });
    } catch {
      setPanel({ kind: 'error', msg: 'No se pudo cargar el diff.' });
    }
  }

  function closePanel() {
    setPanel({ kind: 'none' });
  }

  return (
    <section aria-labelledby="h-hist" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h2
        id="h-hist"
        style={{
          margin: 0,
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: 'var(--muted)',
        }}
      >
        Historial{' '}
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontWeight: 400,
            textTransform: 'none',
            letterSpacing: 0,
          }}
        >
          {versions.length} versiones
        </span>
      </h2>

      <ol
        style={{
          margin: 0,
          padding: 0,
          listStyle: 'none',
          display: 'flex',
          flexDirection: 'column',
          border: '1px solid var(--border)',
          borderRadius: 6,
          overflow: 'hidden',
        }}
      >
        {versions.map((v, idx) => {
          const isHead = v.seq === headSeq;
          return (
            <li
              key={v.seq}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                padding: '10px 12px',
                borderBottom: idx < versions.length - 1 ? '1px solid var(--border)' : undefined,
                background: isHead ? 'var(--bg2)' : undefined,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  <span
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 12,
                      color: 'var(--muted)',
                    }}
                  >
                    {v.hashShort ?? v.hash?.slice(0, 7) ?? '—'}
                    {isHead && (
                      <span style={{ marginLeft: 6, color: 'var(--ok-text)' }}>actual</span>
                    )}
                  </span>
                  <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                    {v.user} · {timeAgo(v.at)}
                  </span>
                </div>
                {!isHead && (
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button
                      type="button"
                      aria-expanded={panel.kind === 'version' && panel.seq === v.seq}
                      onClick={() => void handleViewVersion(v.seq)}
                      style={{
                        height: 26,
                        padding: '0 8px',
                        borderRadius: 4,
                        border: '1px solid var(--border)',
                        background:
                          panel.kind === 'version' && panel.seq === v.seq
                            ? 'var(--card)'
                            : 'transparent',
                        color: 'var(--text)',
                        fontSize: 12,
                        cursor: 'pointer',
                      }}
                    >
                      Ver versión
                    </button>
                    <button
                      type="button"
                      aria-expanded={panel.kind === 'diff' && panel.from === v.seq}
                      onClick={() => void handleDiff(v.seq)}
                      style={{
                        height: 26,
                        padding: '0 8px',
                        borderRadius: 4,
                        border: '1px solid var(--border)',
                        background:
                          panel.kind === 'diff' && panel.from === v.seq
                            ? 'var(--card)'
                            : 'transparent',
                        color: 'var(--text)',
                        fontSize: 12,
                        cursor: 'pointer',
                      }}
                    >
                      Diff
                    </button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {/* Inline panel */}
      {panel.kind !== 'none' && (
        <div
          ref={panelContainerRef}
          style={{
            border: '1px solid var(--border)',
            borderRadius: 6,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 12px',
              borderBottom: '1px solid var(--border)',
              background: 'var(--bg2)',
            }}
          >
            <span
              ref={panelHeadingRef}
              tabIndex={-1}
              style={{ fontSize: 13, fontWeight: 500, outline: 'none' }}
            >
              {panel.kind === 'loading' && 'Cargando…'}
              {panel.kind === 'error' && 'Error'}
              {panel.kind === 'version' && `Versión seq ${panel.seq}`}
              {panel.kind === 'diff' && `Diff seq ${panel.from} → actual`}
            </span>
            <button
              type="button"
              onClick={closePanel}
              aria-label="Cerrar panel"
              style={{
                border: 0,
                background: 'transparent',
                color: 'var(--muted)',
                cursor: 'pointer',
                fontSize: 16,
                lineHeight: 1,
                padding: '2px 6px',
              }}
            >
              ×
            </button>
          </div>

          {panel.kind === 'loading' && (
            <div style={{ padding: 16, color: 'var(--muted)', fontSize: 13 }}>Cargando…</div>
          )}
          {panel.kind === 'error' && (
            <div style={{ padding: 16, color: 'var(--warn-text)', fontSize: 13 }}>{panel.msg}</div>
          )}
          {panel.kind === 'version' && (
            <pre
              style={{
                margin: 0,
                padding: 16,
                overflowX: 'auto',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 12,
                lineHeight: 1.6,
                color: 'var(--text)',
                background: 'var(--bg)',
              }}
            >
              {panel.content}
            </pre>
          )}
          {panel.kind === 'diff' && <DiffLines diff={panel.diff} />}
        </div>
      )}
    </section>
  );
}
