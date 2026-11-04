/** Dashboard page: /g/:slug
 *  Layout: header + hero + (aside vault | main activity)
 *  Responsive: 1280px = two-column; 390px = stacked (vault collapses to row)
 */

import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  type ActivityEvent,
  api,
  type ConflictRow,
  type SummaryResponse,
  type TopicsResponse,
} from '../api.ts';
import { ActivityFeed } from '../components/activity-feed.tsx';
import { useCopy } from '../components/copyable.tsx';
import { Header } from '../components/header.tsx';
import { StatusBadge } from '../components/status-badge.tsx';
import { VaultTree } from '../components/vault-tree.tsx';
import { avatarBg, timeAgo } from '../lib/time.ts';

type LoadState = 'loading' | 'loaded' | 'error' | '404';

const SYNC_CMD = 'npx @chamba/mcp vault sync';

function MemberAvatars({ members }: { members: SummaryResponse['members'] }) {
  const visible = members.slice(0, 4);
  const rest = members.length - visible.length;

  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      {visible.map((m, idx) => (
        <span
          key={m.email ?? m.name}
          aria-hidden="true"
          title={m.name}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            marginLeft: idx === 0 ? 0 : -4,
            borderRadius: 4,
            border: '1px solid var(--bg)',
            background: avatarBg(m.email ?? m.name),
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
            fontWeight: 500,
          }}
        >
          {m.name[0]?.toUpperCase()}
        </span>
      ))}
      {rest > 0 && (
        <span
          style={{
            marginLeft: 8,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
            color: 'var(--muted)',
          }}
        >
          +{rest}
        </span>
      )}
    </div>
  );
}

function SyncBlock() {
  const { copied, copy } = useCopy();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '0 8px' }}>
      <span style={{ fontSize: 12, color: 'var(--muted)' }}>Sincroniza desde tu editor</span>
      <div
        style={{
          display: 'flex',
          alignItems: 'stretch',
          border: '1px solid var(--border)',
          borderRadius: 5,
          background: 'var(--bg2)',
          overflow: 'hidden',
        }}
      >
        <code
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            padding: '0 10px',
            height: 34,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
            whiteSpace: 'nowrap',
            overflowX: 'auto',
          }}
        >
          {SYNC_CMD}
        </code>
        <button
          type="button"
          onClick={() => copy(SYNC_CMD)}
          aria-label="Copiar comando"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 34,
            border: 0,
            borderLeft: '1px solid var(--border)',
            background: 'transparent',
            color: copied ? 'var(--ok-text)' : 'var(--muted)',
            cursor: 'pointer',
          }}
        >
          {copied ? (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M20 6L9 17l-5-5" />
            </svg>
          ) : (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="9" y="9" width="12" height="12" rx="2" />
              <path d="M5 15V5a2 2 0 0 1 2-2h10" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

export function DashboardPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();

  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [topics, setTopics] = useState<TopicsResponse | null>(null);
  const [me, setMe] = useState<{ user: { email: string } } | null>(null);

  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [conflictRows, setConflictRows] = useState<ConflictRow[]>([]);
  const [vaultOpen, setVaultOpen] = useState(false);
  const vaultRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (!slug) return;

    Promise.all([api.getMe(), api.getSummary(slug), api.getActivity(slug), api.getTopics(slug)])
      .then(([meData, summaryData, activityData, topicsData]) => {
        setMe({ user: { email: meData.user.email } });
        setSummary(summaryData);
        setEvents(activityData.events);
        setHasMore(activityData.hasMore);
        setNextBefore(activityData.nextBefore);
        setTopics(topicsData);
        setLoadState('loaded');
        // Fetch actual conflict rows when there are any, so we can build correct links
        if (summaryData.conflicts > 0) {
          api
            .getConflicts(slug)
            .then(setConflictRows)
            .catch(() => {
              // Non-fatal: links stay broken but page still loads
            });
        }
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
  }, [slug, navigate]);

  const handleLoadMore = async () => {
    if (!slug || !nextBefore || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await api.getActivity(slug, { before: nextBefore });
      setEvents((prev) => [...prev, ...r.events]);
      setHasMore(r.hasMore);
      setNextBefore(r.nextBefore);
    } catch {
      // silent
    } finally {
      setLoadingMore(false);
    }
  };

  if (loadState === 'loading') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Header />
        <main style={{ flex: 1 }} />
      </div>
    );
  }

  if (loadState === '404') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Header user={me?.user} />
        <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <p style={{ color: 'var(--muted)' }}>Parche no encontrado.</p>
        </main>
      </div>
    );
  }

  if (loadState === 'error' || !summary) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Header user={me?.user} />
        <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <p style={{ color: 'var(--muted)' }}>Error al cargar. Recarga la página.</p>
        </main>
      </div>
    );
  }

  const { group, notes, conflicts, lastChangeAt, members } = summary;
  const isOwnerOrAdmin = group.role === 'owner' || group.role === 'admin';
  const hasTopics = (topics?.nodes.length ?? 0) > 0;

  // Build conflict link: if 1 conflict, link directly to the copy's view path.
  // If multiple, no single link — the banner renders a dropdown list instead.
  const singleConflictLink =
    conflicts === 1 && conflictRows.length === 1
      ? `/g/${slug}/c/${encodeURIComponent(conflictRows[0]!.copyPath)}`
      : null;

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Header user={me?.user} breadcrumb={[{ label: group.name }]} />

      {/* Hero section */}
      <section
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px 24px',
          padding: '28px 24px 24px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
          <h1
            style={{
              margin: 0,
              fontFamily: "'Space Grotesk', sans-serif",
              fontWeight: 600,
              fontSize: 28,
              letterSpacing: '-0.015em',
              lineHeight: 1.1,
            }}
          >
            {group.name}
          </h1>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
            {conflicts > 0 && singleConflictLink && (
              <Link to={singleConflictLink} style={{ textDecoration: 'none' }}>
                <StatusBadge kind="warn" label="1 conflicto · Ver" />
              </Link>
            )}
            {conflicts > 1 && (
              <span style={{ textDecoration: 'none' }}>
                <StatusBadge
                  kind="warn"
                  label={`${conflicts} conflicto${conflicts > 1 ? 's' : ''}`}
                />
              </span>
            )}
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 12,
                color: 'var(--muted)',
              }}
            >
              {lastChangeAt ? `último sync ${timeAgo(lastChangeAt)}` : 'sin cambios'} · {notes}{' '}
              notas
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
          {/* Member avatars — linked to Miembros page (B-FE5) */}
          <Link
            to={`/g/${slug}/miembros`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              textDecoration: 'none',
            }}
          >
            <MemberAvatars members={members} />
            <span
              style={{
                fontSize: 13,
                color: 'var(--muted)',
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              Miembros
            </span>
          </Link>

          {isOwnerOrAdmin && (
            <Link
              to={`/g/${slug}/invitar`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                height: 36,
                padding: '0 14px',
                borderRadius: 5,
                background: 'var(--accent)',
                color: 'var(--bg)',
                fontSize: 14,
                fontWeight: 600,
                textDecoration: 'none',
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.25"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              Invitar
            </Link>
          )}
        </div>
      </section>

      {/* Body: aside + main */}
      <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap', alignItems: 'stretch' }}>
        {/* Mobile vault toggle (hidden on wide screens via inline trick) */}
        <details
          ref={vaultRef}
          open={vaultOpen}
          onToggle={(e) => setVaultOpen((e.currentTarget as HTMLDetailsElement).open)}
          style={{
            width: '100%',
            borderBottom: '1px solid var(--border)',
          }}
          className="vault-mobile"
        >
          <summary
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 24px',
              cursor: 'pointer',
              listStyle: 'none',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 13,
              userSelect: 'none',
            }}
          >
            <span>
              Vault · <span style={{ color: 'var(--muted)' }}>{notes} notas</span>
            </span>
            <span style={{ color: 'var(--muted)' }}>{vaultOpen ? '▲' : '›'}</span>
          </summary>
          <div style={{ padding: '0 0 16px' }}>
            {slug && <VaultTree slug={slug} />}
            <div style={{ padding: '16px 16px 0' }}>
              <SyncBlock />
            </div>
          </div>
        </details>

        {/* Desktop aside (always visible on wide) */}
        <aside
          aria-label="Árbol del vault"
          style={{
            flex: '1 1 260px',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            padding: '20px 16px',
            borderRight: '1px solid var(--border)',
          }}
          className="vault-desktop"
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              padding: '0 8px',
            }}
          >
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                color: 'var(--muted)',
              }}
            >
              Vault
            </span>
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 12,
                color: 'var(--muted)',
              }}
            >
              {notes}
            </span>
          </div>

          {slug && <VaultTree slug={slug} />}

          {hasTopics && (
            <div style={{ padding: '0 8px' }}>
              <Link
                to={`/g/${slug}/topics`}
                style={{
                  fontSize: 12,
                  color: 'var(--muted)',
                  textDecoration: 'none',
                  borderBottom: '1px solid transparent',
                }}
              >
                Temas →
              </Link>
            </div>
          )}

          <div style={{ marginTop: 'auto' }}>
            <SyncBlock />
          </div>
        </aside>

        {/* Main: activity */}
        <main style={{ flex: '999 1 560px', minWidth: 0, padding: '20px 24px 48px' }}>
          <div style={{ maxWidth: 860, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
              }}
            >
              <h2
                style={{
                  margin: 0,
                  fontFamily: "'Space Grotesk', sans-serif",
                  fontWeight: 600,
                  fontSize: 16,
                }}
              >
                Actividad
              </h2>
            </div>

            {/* Conflict banner */}
            {conflicts > 0 && (
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '12px 16px',
                  border: '1px solid oklch(0.83 0.11 88 / 0.45)',
                  borderRadius: 6,
                  background: 'oklch(0.83 0.11 88 / 0.06)',
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                  <span style={{ fontSize: 14 }}>
                    <strong style={{ fontWeight: 600, color: 'var(--warn-text)' }}>
                      {conflicts} conflicto{conflicts > 1 ? 's' : ''}
                    </strong>{' '}
                    en el vault
                  </span>
                  <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                    Dos versiones del mismo archivo guardadas. Resuélvelos desde tu editor.
                  </span>
                  {/* Multiple conflicts: inline list linking each to its view */}
                  {conflicts > 1 && conflictRows.length > 1 && (
                    <details style={{ marginTop: 4 }}>
                      <summary
                        style={{
                          fontSize: 13,
                          color: 'var(--warn-text)',
                          cursor: 'pointer',
                          fontWeight: 600,
                        }}
                      >
                        Ver todos ({conflictRows.length})
                      </summary>
                      <ul
                        style={{
                          margin: '6px 0 0',
                          paddingLeft: 16,
                          listStyle: 'disc',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 4,
                        }}
                      >
                        {conflictRows.map((c) => (
                          <li key={c.copyPath} style={{ fontSize: 13 }}>
                            <Link
                              to={`/g/${slug}/c/${encodeURIComponent(c.copyPath)}`}
                              style={{ color: 'var(--warn-text)', textDecoration: 'underline' }}
                            >
                              {c.copyPath}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
                {/* Single conflict: direct link to its view */}
                {singleConflictLink && (
                  <Link
                    to={singleConflictLink}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      height: 32,
                      padding: '0 12px',
                      borderRadius: 5,
                      border: '1px solid oklch(0.83 0.11 88 / 0.6)',
                      color: 'var(--warn-text)',
                      fontSize: 13,
                      fontWeight: 600,
                      textDecoration: 'none',
                    }}
                  >
                    Ver
                  </Link>
                )}
              </div>
            )}

            {slug && (
              <ActivityFeed
                slug={slug}
                events={events}
                hasMore={hasMore}
                loadingMore={loadingMore}
                onLoadMore={() => void handleLoadMore()}
              />
            )}
          </div>
        </main>
      </div>

      {/* Responsive styles: hide vault-mobile on wide, hide vault-desktop on narrow */}
      <style>{`
        @media (min-width: 640px) {
          .vault-mobile { display: none !important; }
        }
        @media (max-width: 639px) {
          .vault-desktop { display: none !important; }
        }
      `}</style>
    </div>
  );
}
