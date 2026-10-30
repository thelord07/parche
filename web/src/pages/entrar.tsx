import { useState } from 'react';
import { api } from '../api.ts';
import { Button } from '../components/button.tsx';
import { Field } from '../components/field.tsx';
import { Header } from '../components/header.tsx';

type State = 'idle' | 'sending' | 'sent' | 'error';

export function EntrarPage() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<State>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setState('sending');
    try {
      await api.requestMagicLink(email);
      setState('sent');
    } catch {
      setState('error');
      setErrorMsg('Algo salió mal. Intenta de nuevo.');
    }
  }

  if (state === 'sent') {
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
                  lineHeight: 1.15,
                }}
              >
                Revisa tu correo
              </h1>
              <p style={{ margin: 0, fontSize: 15, lineHeight: 1.5, color: 'var(--muted)' }}>
                Si ese correo tiene acceso, mandamos un link.{' '}
                <span
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 14,
                    color: 'var(--text)',
                  }}
                >
                  {email}
                </span>
                . Vence en 15 min.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setState('idle');
                setEmail('');
              }}
              style={{
                alignSelf: 'flex-start',
                background: 'none',
                border: 'none',
                color: 'var(--muted)',
                fontSize: 14,
                cursor: 'pointer',
                textDecoration: 'underline',
                textUnderlineOffset: 3,
                padding: 0,
              }}
            >
              Cambiar correo
            </button>
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
                lineHeight: 1.15,
              }}
            >
              Entra a parche
            </h1>
            <p style={{ margin: 0, fontSize: 15, lineHeight: 1.5, color: 'var(--muted)' }}>
              Te mandamos un link al correo. Sin contraseñas.
            </p>
          </div>
          <form
            onSubmit={handleSubmit}
            style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
          >
            <Field
              label="Correo"
              id="email"
              type="email"
              autoComplete="email"
              placeholder="tu@equipo.dev"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              error={state === 'error' ? errorMsg : undefined}
            />
            <Button
              type="submit"
              variant="primary"
              disabled={state === 'sending'}
              style={{ marginTop: 8 }}
            >
              {state === 'sending' ? 'Enviando…' : 'Enviar link'}
            </Button>
          </form>
        </div>
      </main>
    </div>
  );
}
