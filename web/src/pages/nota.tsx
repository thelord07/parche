/** Note page: /g/:slug/n/* (splat — paths with '/' and spaces/ñ)
 *  Layout: header + (main article + backlinks | aside metadata + history)
 *  Responsive: 1280 = two-column; 390 = stacked
 */

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type NoteResponse } from '../api.ts';
import { Header } from '../components/header.tsx';
import { HistoryList } from '../components/history-list.tsx';
import { MetadataList } from '../components/metadata-list.tsx';
import { NoteArticle } from '../components/note-article.tsx';
import { StatusBadge } from '../components/status-badge.tsx';
import { timeAgo } from '../lib/time.ts';

type LoadState = 'loading' | 'loaded' | 'error' | '404';

export function NotaPage() {
  const { slug, '*': splatPath } = useParams<{ slug: string; '*': string }>();
  const navigate = useNavigate();

  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [note, setNote] = useState<NoteResponse | null>(null);
  const [me, setMe] = useState<{ user: { email: string } } | null>(null);

  const path = splatPath ?? '';

  useEffect(() => {
    if (!slug || !path) return;

    Promise.all([api.getMe(), api.getNote(slug, path)])
      .then(([meData, noteData]) => {
        setMe({ user: { email: meData.user.email } });
        setNote(noteData);
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
  }, [slug, path, navigate]);

  const breadcrumb = [{ label: slug ?? '', href: `/g/${slug}` }, { label: path }];

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
          <p style={{ color: 'var(--muted)' }}>Nota no encontrada.</p>
        </main>
      </div>
    );
  }

  if (loadState === 'error' || !note) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Header user={me?.user} breadcrumb={breadcrumb} />
        <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <p style={{ color: 'var(--muted)' }}>Error al cargar. Recarga la página.</p>
        </main>
      </div>
    );
  }

  const { title, meta, head, versions, backlinks, html, metaPending } = note;

  const tags = meta?.tags.filter((t) => t.startsWith('tema/')) ?? [];

  const metaItems = [
    {
      label: 'Autor',
      value: head?.user.name || head?.user.email || '—',
    },
    ...(meta?.project ? [{ label: 'Repo', value: meta.project, mono: true }] : []),
    ...(meta?.workItem ? [{ label: 'Ticket', value: meta.workItem, mono: true }] : []),
    {
      label: 'Estado',
      value: metaPending ? 'procesando…' : 'Activa',
      color: metaPending ? 'var(--muted)' : 'var(--ok-text)',
    },
    ...(head?.hashShort ? [{ label: 'Hash', value: head.hashShort, mono: true }] : []),
    ...(head?.at ? [{ label: 'Editada', value: timeAgo(head.at), mono: true }] : []),
    ...(tags.length > 0
      ? [{ label: 'Temas', value: tags.map((t) => t.replace('tema/', '')).join(', ') }]
      : []),
  ];

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Header user={me?.user} breadcrumb={breadcrumb} />

      <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap', gap: 0 }}>
        {/* Main article */}
        <main
          style={{
            flex: '999 1 560px',
            minWidth: 0,
            padding: '40px 48px 64px',
            borderRight: '1px solid var(--border)',
          }}
        >
          <div
            style={{
              maxWidth: 680,
              margin: '0 auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 20,
            }}
          >
            {/* Path + badge + read-only label */}
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
              <code
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 12,
                  color: 'var(--muted)',
                }}
              >
                {path}
              </code>
              <StatusBadge
                kind={metaPending ? 'pending' : 'ok'}
                label={metaPending ? 'procesando…' : 'Activa'}
              />
              <span
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 11,
                  color: 'var(--muted)',
                }}
              >
                Solo lectura · edita desde tu editor
              </span>
            </div>

            {/* Title */}
            <h1
              style={{
                margin: 0,
                fontFamily: "'Space Grotesk', sans-serif",
                fontWeight: 600,
                fontSize: 34,
                letterSpacing: '-0.02em',
                lineHeight: 1.15,
              }}
            >
              {title ?? path.split('/').pop() ?? path}
            </h1>

            {/* Article content */}
            {metaPending ? (
              <p style={{ color: 'var(--muted)', fontStyle: 'italic' }}>
                Procesando metadatos, el contenido estará listo en un momento…
              </p>
            ) : html ? (
              <NoteArticle html={html} />
            ) : (
              <p style={{ color: 'var(--muted)' }}>Sin contenido.</p>
            )}

            {/* Backlinks */}
            {backlinks.length > 0 && (
              <section
                aria-labelledby="h-bl"
                style={{
                  marginTop: 24,
                  paddingTop: 24,
                  borderTop: '1px solid var(--border)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <h2
                  id="h-bl"
                  style={{
                    margin: '0 0 4px',
                    fontSize: 13,
                    fontWeight: 600,
                    color: 'var(--muted)',
                  }}
                >
                  Enlazada desde{' '}
                  <span
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontWeight: 400,
                    }}
                  >
                    {backlinks.length}
                  </span>
                </h2>
                {backlinks.map((bl) => (
                  <Link
                    key={bl.path}
                    to={`/g/${slug}/n/${bl.path}`}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 2,
                      padding: '10px 12px',
                      border: '1px solid var(--border)',
                      borderRadius: 5,
                      textDecoration: 'none',
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.background = 'var(--bg2)';
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.background = 'transparent';
                    }}
                  >
                    <code
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 13,
                        color: 'var(--text)',
                      }}
                    >
                      {bl.path}
                    </code>
                    {bl.snippet && (
                      <span style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--muted)' }}>
                        {bl.snippet}
                      </span>
                    )}
                  </Link>
                ))}
              </section>
            )}
          </div>
        </main>

        {/* Aside: metadata + history */}
        <aside
          style={{
            flex: '1 1 300px',
            minWidth: 0,
            padding: '32px 24px',
            display: 'flex',
            flexDirection: 'column',
            gap: 32,
          }}
        >
          {/* Metadata section */}
          <section
            aria-labelledby="h-meta"
            style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
          >
            <h2
              id="h-meta"
              style={{
                margin: 0,
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                color: 'var(--muted)',
              }}
            >
              Metadatos
            </h2>
            <MetadataList items={metaItems} />
          </section>

          {/* History section */}
          {versions.length > 0 && head && (
            <HistoryList slug={slug ?? ''} path={path} versions={versions} headSeq={head.seq} />
          )}
        </aside>
      </div>
    </div>
  );
}
