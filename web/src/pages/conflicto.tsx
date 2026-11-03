/** Conflict view page: /g/:slug/c/* (splat — copyPath)
 *  Shows original vs copy side by side with diff marks.
 *  Entrega A: NO action buttons — only text "Resuélvelo en tu editor y sincroniza".
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, type ConflictViewResponse } from '../api.ts';
import { buildPanels, type PanelLine } from '../components/diff-view.tsx';
import { Header } from '../components/header.tsx';
import { StatusBadge } from '../components/status-badge.tsx';
import { timeAgo } from '../lib/time.ts';

type LoadState = 'loading' | 'loaded' | 'error' | '404';

export function ConflictoPage() {
  const { slug, '*': splatPath } = useParams<{ slug: string; '*': string }>();
  const navigate = useNavigate();

  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [data, setData] = useState<ConflictViewResponse | null>(null);
  const [me, setMe] = useState<{ user: { email: string } } | null>(null);

  const copyPath = splatPath ?? '';

  useEffect(() => {
    // Empty splat = no copyPath → show 404 immediately instead of a loader that never resolves
    if (!slug || !copyPath) {
      setLoadState('404');
      return;
    }

    Promise.all([api.getMe(), api.getConflictView(slug, copyPath)])
      .then(([meData, conflictData]) => {
        setMe({ user: { email: meData.user.email } });
        setData(conflictData);
        setLoadState('loaded');
      })
      .catch((err: unknown) => {
        const status = (err as { status?: number }).status;
        if (status === 401) {
          navigate('/entrar', { replace: true });
        } else if (status === 404) {
          setLoadState('404');
        } else {
          setLoadState('error');
        }
      });
  }, [slug, copyPath, navigate]);

  const breadcrumb = [{ label: slug ?? '', href: `/g/${slug}` }, { label: 'conflicto' }];

  if (loadState === 'loading') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Header breadcrumb={breadcrumb} />
        <main style={{ flex: 1 }} />
      </div>
    );
  }

  if (loadState === '404') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Header user={me?.user} breadcrumb={breadcrumb} />
        <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <p style={{ color: 'var(--muted)' }}>Conflicto no encontrado.</p>
        </main>
      </div>
    );
  }

  if (loadState === 'error' || !data) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Header user={me?.user} breadcrumb={breadcrumb} />
        <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <p style={{ color: 'var(--muted)' }}>Error al cargar. Recarga la página.</p>
        </main>
      </div>
    );
  }

  const { originalPath, base, original, copy } = data;

  const originalName = original?.author ?? 'desconocido';
  const copyName = copy?.author ?? 'desconocido';

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Header user={me?.user} breadcrumb={breadcrumb} />

      <main style={{ flex: 1, padding: '40px 24px 64px' }}>
        <div
          style={{
            maxWidth: 1200,
            margin: '0 auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 24,
          }}
        >
          {/* Header */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <span style={{ alignSelf: 'flex-start' }}>
              <StatusBadge kind="warn" label="1 conflicto" />
            </span>
            <h1
              style={{
                margin: 0,
                fontFamily: "'Space Grotesk', sans-serif",
                fontWeight: 600,
                fontSize: 28,
                letterSpacing: '-0.015em',
                lineHeight: 1.2,
              }}
            >
              Dos versiones de{' '}
              <code
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 24,
                  fontWeight: 500,
                }}
              >
                {originalPath}
              </code>
            </h1>
            <p
              style={{
                margin: 0,
                fontSize: 15,
                lineHeight: 1.55,
                color: 'var(--muted)',
                maxWidth: 720,
              }}
            >
              {originalName} y {copyName} la editaron
              {base ? (
                <>
                  {' '}
                  a partir de{' '}
                  <code
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 13,
                      color: 'var(--text)',
                    }}
                  >
                    {base.slice(0, 7)}
                  </code>
                </>
              ) : (
                ''
              )}
              . Las dos están guardadas.
            </p>
          </div>

          {/* Side-by-side panels with diff marks.
               buildPanels maps DiffEntry[] → left/right PanelLine[] so every line
               carries a mark ('~' mod/del, '+' add, '' eq) and a tinted background. */}
          {(() => {
            const { left: leftLines, right: rightLines } = buildPanels(data.diff);

            /** Render one annotated diff line inside a <pre><code> block. */
            const renderLine = (line: PanelLine, keyPrefix: string) => {
              const isWarn = line.mark === '~';
              const isOk = line.mark === '+';
              return (
                <span
                  key={`${keyPrefix}-${line.lineNo}`}
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
            };

            return (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
                {/* Original panel */}
                <section
                  aria-labelledby="h-original"
                  style={{
                    flex: '1 1 440px',
                    minWidth: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                      padding: '12px 16px',
                      borderBottom: '1px solid var(--border)',
                      background: 'var(--bg2)',
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                      <h2 id="h-original" style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
                        Versión de {originalName}
                      </h2>
                      <span
                        style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 12,
                          color: 'var(--muted)',
                        }}
                      >
                        {original?.hashShort ?? '—'}
                        {original?.device ? ` · ${original.device}` : ''}
                        {original?.at ? ` · ${timeAgo(original.at)}` : ''}
                      </span>
                    </div>
                    {/* No action button in Entrega A */}
                  </div>
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
                      {leftLines.map((line) => renderLine(line, 'orig'))}
                    </code>
                  </pre>
                </section>

                {/* Copy panel */}
                <section
                  aria-labelledby="h-copy"
                  style={{
                    flex: '1 1 440px',
                    minWidth: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                      padding: '12px 16px',
                      borderBottom: '1px solid var(--border)',
                      background: 'var(--bg2)',
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                      <h2 id="h-copy" style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
                        Versión de {copyName}
                      </h2>
                      <span
                        style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 12,
                          color: 'var(--muted)',
                        }}
                      >
                        {copy?.hashShort ?? '—'}
                        {copy?.device ? ` · ${copy.device}` : ''}
                        {copy?.at ? ` · ${timeAgo(copy.at)}` : ''}
                      </span>
                    </div>
                    {/* No action button in Entrega A */}
                  </div>
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
                      {rightLines.map((line) => renderLine(line, 'copy'))}
                    </code>
                  </pre>
                </section>
              </div>
            );
          })()}

          {/* Entrega A: resolution message instead of action buttons */}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 16,
              padding: '16px',
              border: '1px solid var(--border)',
              borderRadius: 6,
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>
                Resuélvelo en tu editor y sincroniza
              </span>
              <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                Abre el archivo en tu editor, elige qué versión conservar y ejecuta{' '}
                <code
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 12,
                    background: 'var(--bg2)',
                    border: '1px solid var(--border)',
                    borderRadius: 4,
                    padding: '1px 5px',
                  }}
                >
                  npx @chamba/mcp vault sync
                </code>
                .
              </span>
            </div>
          </div>

          {/* Legend */}
          <p
            style={{
              margin: 0,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12,
              color: 'var(--muted)',
            }}
          >
            <span aria-hidden="true">~</span> línea distinta · <span aria-hidden="true">+</span>{' '}
            línea nueva · cualquier opción deja la otra versión en el historial
          </p>
        </div>
      </main>
    </div>
  );
}
