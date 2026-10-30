import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type MeResponse } from '../api.ts';
import { Header } from '../components/header.tsx';

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  editor: 'Editor',
  reader: 'Lector',
};

type State = 'loading' | 'loaded' | 'error';

export function InicioPage() {
  const navigate = useNavigate();
  const [state, setState] = useState<State>('loading');
  const [me, setMe] = useState<MeResponse | null>(null);

  useEffect(() => {
    api
      .getMe()
      .then((data) => {
        setMe(data);
        setState('loaded');
      })
      .catch((err: unknown) => {
        const status = (err as { status?: number }).status;
        if (status === 401) {
          navigate('/entrar', { replace: true });
        } else {
          setState('error');
        }
      });
  }, [navigate]);

  if (state === 'loading') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Header />
        <main style={{ flex: 1 }} />
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Header />
        <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <p style={{ color: 'var(--muted)' }}>Error al cargar. Recarga la página.</p>
        </main>
      </div>
    );
  }

  const groups = me?.groups ?? [];

  if (groups.length === 0) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Header user={me?.user} />
        <main style={{ flex: 1, padding: '120px 24px 48px' }}>
          <div
            style={{
              maxWidth: 560,
              margin: '0 auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 32,
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <span
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 12,
                  color: 'var(--muted)',
                }}
              >
                0 parches
              </span>
              <h1
                style={{
                  margin: 0,
                  fontFamily: "'Space Grotesk', sans-serif",
                  fontWeight: 600,
                  fontSize: 32,
                  letterSpacing: '-0.015em',
                  lineHeight: 1.15,
                }}
              >
                Todavía no tienes parche
              </h1>
              <p
                style={{
                  margin: 0,
                  fontSize: 15,
                  lineHeight: 1.55,
                  color: 'var(--muted)',
                  maxWidth: 460,
                }}
              >
                Un parche es un vault de notas markdown que tu equipo sincroniza desde el editor.
              </p>
            </div>
            <div>
              <Link
                to="/nuevo"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  height: 40,
                  padding: '0 16px',
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
                Crea tu parche
              </Link>
            </div>
            <p
              style={{
                margin: 0,
                paddingTop: 24,
                borderTop: '1px solid var(--border)',
                fontSize: 14,
                lineHeight: 1.6,
                color: 'var(--muted)',
              }}
            >
              ¿Te invitaron? Únete con{' '}
              <code
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 13,
                  color: 'var(--text)',
                  background: 'var(--bg2)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  padding: '2px 6px',
                }}
              >
                vault join &lt;código&gt;
              </code>{' '}
              desde tu editor.
            </p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Header user={me?.user} />
      <main style={{ flex: 1, padding: '48px 24px' }}>
        <div
          style={{
            maxWidth: 640,
            margin: '0 auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 24,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 16,
            }}
          >
            <h1
              style={{
                margin: 0,
                fontFamily: "'Space Grotesk', sans-serif",
                fontWeight: 600,
                fontSize: 28,
                letterSpacing: '-0.015em',
              }}
            >
              Tus parches
            </h1>
            <Link
              to="/nuevo"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                height: 36,
                padding: '0 12px',
                borderRadius: 5,
                background: 'var(--accent)',
                color: 'var(--bg)',
                fontSize: 13,
                fontWeight: 600,
                textDecoration: 'none',
              }}
            >
              + Nuevo
            </Link>
          </div>
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            {groups.map((g) => (
              <li
                key={g.slug}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 16,
                  padding: '16px',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  background: 'var(--card)',
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                  <span style={{ fontWeight: 600, fontSize: 15 }}>{g.name}</span>
                  <span
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 12,
                      color: 'var(--muted)',
                    }}
                  >
                    {g.slug} · {ROLE_LABELS[g.role] ?? g.role}
                  </span>
                </div>
                {(g.role === 'owner' || g.role === 'admin') && (
                  <Link
                    to={`/g/${g.slug}/invitar`}
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      color: 'var(--accent)',
                      textDecoration: 'none',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    Invitar →
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </div>
      </main>
    </div>
  );
}
