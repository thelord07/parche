import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type MeResponse } from '../api.ts';
import { Header } from '../components/header.tsx';
import { slugify } from '../lib/slug.ts';

type State = 'idle' | 'submitting' | 'error';

export function NuevoPage() {
  const navigate = useNavigate();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [touched, setTouched] = useState(false);
  const [state, setState] = useState<State>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    api
      .getMe()
      .then(setMe)
      .catch((err: unknown) => {
        const status = (err as { status?: number }).status;
        if (status === 401) {
          navigate('/entrar', { replace: true });
        }
        // Non-401 errors: page remains usable, just no user chip
      });
  }, [navigate]);

  function handleNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    setName(v);
    if (!touched) {
      setSlug(slugify(v));
    }
  }

  function handleSlugChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .slice(0, 40);
    setSlug(v);
    setTouched(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setState('submitting');
    setErrorMsg('');
    try {
      const result = await api.createGroup(name.trim(), slug.trim());
      navigate(`/g/${result.slug}/invitar`);
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 409) {
        setErrorMsg('Ese slug ya existe. Elige otro.');
      } else if (status === 403) {
        setErrorMsg('No tienes permiso para crear parches.');
      } else {
        setErrorMsg('Algo salió mal. Intenta de nuevo.');
      }
      setState('error');
    }
  }

  const SLUG_RE = /^[a-z0-9-]{3,40}$/;
  const slugTooShort = slug.trim().length > 0 && slug.trim().length < 3;
  const slugInvalid = slug.trim().length > 0 && !SLUG_RE.test(slug.trim());
  const slugError =
    slugTooShort || slugInvalid
      ? 'El slug debe tener entre 3 y 40 caracteres (letras, números y guiones).'
      : '';

  const slugHint = errorMsg
    ? errorMsg
    : slugError
      ? slugError
      : touched
        ? 'Editado a mano.'
        : 'Se genera del nombre. Puedes editarlo.';

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Header user={me?.user} breadcrumb={[{ label: 'nuevo' }]} />
      <main style={{ flex: 1, padding: '120px 24px 48px' }}>
        <div
          style={{
            maxWidth: 480,
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
              1/2
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
              Crea tu parche
            </h1>
          </div>
          <form
            onSubmit={handleSubmit}
            style={{ display: 'flex', flexDirection: 'column', gap: 20 }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label htmlFor="nombre" style={{ fontSize: 13, fontWeight: 500 }}>
                Nombre
              </label>
              <div
                style={{
                  display: 'flex',
                  height: 40,
                  border: '1px solid var(--border)',
                  borderRadius: 5,
                  background: 'var(--bg2)',
                }}
              >
                <input
                  id="nombre"
                  type="text"
                  value={name}
                  onChange={handleNameChange}
                  placeholder="Backend Lapzo"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: '0 12px',
                    border: 0,
                    background: 'transparent',
                    color: 'var(--text)',
                    fontFamily: "'Instrument Sans', sans-serif",
                    fontSize: 15,
                    outline: 'none',
                  }}
                />
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label htmlFor="slug" style={{ fontSize: 13, fontWeight: 500 }}>
                Slug
              </label>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  height: 40,
                  border: `1px solid ${errorMsg || slugError ? 'var(--warn)' : 'var(--border)'}`,
                  borderRadius: 5,
                  background: 'var(--bg2)',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 13,
                  overflow: 'hidden',
                }}
              >
                <span
                  style={{ padding: '0 0 0 12px', color: 'var(--muted)', whiteSpace: 'nowrap' }}
                >
                  parche.chamba.tools/
                </span>
                <input
                  id="slug"
                  type="text"
                  value={slug}
                  onChange={handleSlugChange}
                  spellCheck={false}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: '0 12px 0 0',
                    border: 0,
                    background: 'transparent',
                    color: 'var(--text)',
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 13,
                    outline: 'none',
                  }}
                />
              </div>
              <span
                style={{
                  fontSize: 13,
                  color: errorMsg || slugError ? 'var(--warn)' : 'var(--muted)',
                }}
                role={errorMsg || slugError ? 'alert' : undefined}
              >
                {slugHint}
              </span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 12 }}>
              <button
                type="submit"
                disabled={state === 'submitting' || !name.trim() || !slug.trim() || !!slugError}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
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
                {state === 'submitting' ? 'Creando…' : 'Crear parche'}
              </button>
              <button
                type="button"
                onClick={() => navigate('/')}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  height: 40,
                  padding: '0 16px',
                  borderRadius: 5,
                  border: '1px solid var(--border)',
                  background: 'transparent',
                  color: 'var(--text)',
                  fontSize: 14,
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                Cancelar
              </button>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}
