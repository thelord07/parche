import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, type InviteCheckResult } from '../api.ts';
import { CodeBlock } from '../components/code-block.tsx';
import { useCopy } from '../components/copyable.tsx';
import { Header } from '../components/header.tsx';

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  editor: 'Editor',
  reader: 'Lector',
};

type State = 'loading' | 'valid' | 'invalid';

export function UnisrsePage() {
  const { codigo } = useParams<{ codigo: string }>();
  const [state, setState] = useState<State>('loading');
  const [info, setInfo] = useState<InviteCheckResult | null>(null);
  const { copied, copy } = useCopy();

  useEffect(() => {
    if (!codigo) {
      setState('invalid');
      return;
    }
    api
      .checkInvite(codigo)
      .then((result) => {
        setInfo(result);
        setState(result.valid ? 'valid' : 'invalid');
      })
      .catch(() => {
        setState('invalid');
      });
  }, [codigo]);

  const command = `npx @chamba/mcp@latest vault join ${codigo ?? ''}`;

  if (state === 'loading') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Header />
        <main style={{ flex: 1 }} />
      </div>
    );
  }

  if (state === 'invalid' || !info?.valid) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Header />
        <main
          style={{ flex: 1, display: 'flex', justifyContent: 'center', padding: '104px 16px 48px' }}
        >
          <div
            style={{
              width: '100%',
              maxWidth: 440,
              display: 'flex',
              flexDirection: 'column',
              gap: 24,
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <span
                style={{
                  display: 'inline-flex',
                  alignSelf: 'flex-start',
                  alignItems: 'center',
                  gap: 6,
                  height: 24,
                  padding: '0 8px',
                  border: '1px solid color-mix(in srgb, var(--warn) 45%, transparent)',
                  borderRadius: 4,
                  color: 'var(--warn)',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 12,
                }}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 8v5M12 16.5v.5" />
                  <path d="M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                </svg>
                Invitación no válida
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
                Esta invitación ya no sirve
              </h1>
              <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55, color: 'var(--muted)' }}>
                <code
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 14,
                    color: 'var(--text)',
                  }}
                >
                  {codigo}
                </code>{' '}
                no es válida. Pídele a alguien un código nuevo.
              </p>
            </div>
            <a
              href="/entrar"
              style={{
                alignSelf: 'flex-start',
                display: 'inline-flex',
                alignItems: 'center',
                height: 40,
                padding: '0 16px',
                borderRadius: 5,
                border: '1px solid var(--border)',
                color: 'var(--text)',
                fontSize: 14,
                fontWeight: 500,
                textDecoration: 'none',
              }}
            >
              Entrar a parche
            </a>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Header />
      <main
        style={{ flex: 1, display: 'flex', justifyContent: 'center', padding: '104px 16px 48px' }}
      >
        <div
          style={{
            width: '100%',
            maxWidth: 440,
            display: 'flex',
            flexDirection: 'column',
            gap: 28,
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
              Invitación · {codigo}
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
              {info.inviter} te invitó a{' '}
              <span
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontWeight: 500,
                  fontSize: 26,
                }}
              >
                {info.group?.slug}
              </span>
            </h1>
            <p style={{ margin: 0, fontSize: 14, color: 'var(--muted)' }}>
              Entras como {ROLE_LABELS[info.role ?? ''] ?? info.role} · vence{' '}
              {info.expiresLabel ?? 'nunca'}
            </p>
          </div>

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              paddingTop: 24,
              borderTop: '1px solid var(--border)',
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 500 }}>Únete desde tu editor:</span>
            <CodeBlock
              command={command}
              onCopy={() => copy(command)}
              copied={copied}
              copyLabel="Copiar"
              copiedLabel="Copiado"
              variant="secondary"
            />
          </div>
        </div>
      </main>
    </div>
  );
}
