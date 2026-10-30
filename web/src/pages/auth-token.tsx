import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.ts';
import { Header } from '../components/header.tsx';

type State = 'idle' | 'verifying' | 'error';

export function AuthTokenPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<State>('idle');

  async function handleEntrar() {
    if (!token) return;
    setState('verifying');
    try {
      await api.verifyToken(token);
      navigate('/');
    } catch {
      setState('error');
    }
  }

  if (state === 'error') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Header />
        <main
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '48px 16px',
          }}
        >
          <div
            style={{
              width: '100%',
              maxWidth: 360,
              display: 'flex',
              flexDirection: 'column',
              gap: 24,
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <h1
                style={{
                  margin: 0,
                  fontFamily: "'Space Grotesk', sans-serif",
                  fontWeight: 600,
                  fontSize: 28,
                  letterSpacing: '-0.015em',
                }}
              >
                Link usado o vencido
              </h1>
              <p style={{ margin: 0, fontSize: 15, lineHeight: 1.5, color: 'var(--muted)' }}>
                Este link ya fue usado o venció. Pide uno nuevo.
              </p>
            </div>
            <a
              href="/entrar"
              style={{
                alignSelf: 'flex-start',
                fontSize: 14,
                color: 'var(--accent)',
                textDecoration: 'none',
              }}
            >
              Volver a entrar →
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
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '48px 16px',
        }}
      >
        <div
          style={{
            width: '100%',
            maxWidth: 360,
            display: 'flex',
            flexDirection: 'column',
            gap: 24,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h1
              style={{
                margin: 0,
                fontFamily: "'Space Grotesk', sans-serif",
                fontWeight: 600,
                fontSize: 28,
                letterSpacing: '-0.015em',
              }}
            >
              ¿Listo para entrar?
            </h1>
            <p style={{ margin: 0, fontSize: 15, lineHeight: 1.5, color: 'var(--muted)' }}>
              Haz clic para confirmar tu sesión.
            </p>
          </div>
          <button
            type="button"
            onClick={handleEntrar}
            disabled={state === 'verifying'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: 40,
              padding: '0 16px',
              borderRadius: 5,
              background: 'var(--accent)',
              color: 'var(--bg)',
              fontSize: 14,
              fontWeight: 600,
              border: 0,
              cursor: 'pointer',
            }}
          >
            {state === 'verifying' ? 'Entrando…' : 'Entrar'}
          </button>
        </div>
      </main>
    </div>
  );
}
