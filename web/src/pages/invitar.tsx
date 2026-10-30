import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, type InviteRow } from '../api.ts';
import { CodeBlock } from '../components/code-block.tsx';
import { CopyButton, useCopy } from '../components/copyable.tsx';
import { Header } from '../components/header.tsx';

const ROLE_LABELS: Record<string, string> = {
  admin: 'Admin',
  editor: 'Editor',
  reader: 'Lector',
};

const ROLE_HINTS: Record<string, string> = {
  admin: 'Puede invitar y administrar el parche.',
  editor: 'Puede guardar y editar notas.',
  reader: 'Solo lee y sincroniza.',
};

interface NewInviteState {
  code: string;
}

export function InvitarPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [loadError, setLoadError] = useState('');
  const [newInvite, setNewInvite] = useState<NewInviteState | null>(null);
  const [role, setRole] = useState<'admin' | 'editor' | 'reader'>('editor');
  const [expires, setExpires] = useState<'24h' | '7d' | 'never'>('7d');
  const [maxUses, setMaxUses] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState('');

  const cmdCopy = useCopy();
  const linkCopy = useCopy();

  useEffect(() => {
    if (!slug) return;
    api
      .getInvites(slug)
      .then(setInvites)
      .catch((err: unknown) => {
        const status = (err as { status?: number }).status;
        if (status === 401) {
          navigate('/entrar', { replace: true });
        } else if (status === 403 || status === 404) {
          setLoadError('No tienes acceso a este parche.');
        } else {
          setLoadError('Error al cargar las invitaciones.');
        }
      });
  }, [slug, navigate]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!slug) return;
    setCreating(true);
    setCreateError('');
    try {
      const parsed = maxUses.trim() ? parseInt(maxUses, 10) : null;
      const result = await api.createInvite(slug, role, expires, parsed);
      setNewInvite({ code: result.code });
      const updated = await api.getInvites(slug);
      setInvites(updated);
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 403) {
        setCreateError('No tienes permiso para crear invitaciones.');
      } else {
        setCreateError('No se pudo crear la invitación. Intenta de nuevo.');
      }
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(id: string) {
    if (!slug) return;
    setRevoking(id);
    setRevokeError('');
    try {
      await api.revokeInvite(slug, id);
      setInvites((prev) => prev.filter((i) => i.id !== id));
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 403) {
        setRevokeError('No tienes permiso para revocar esta invitación.');
      } else {
        setRevokeError('No se pudo revocar. Intenta de nuevo.');
      }
    } finally {
      setRevoking(null);
    }
  }

  const code = newInvite?.code ?? '';
  const command = `npx @chamba/mcp@latest vault join ${code}`;
  // Full URL for copy and display so the recipient gets a working link
  const fullLink =
    typeof window !== 'undefined' ? `${window.location.origin}/j/${code}` : `/j/${code}`;

  if (loadError) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Header breadcrumb={[{ label: slug ?? '' }, { label: 'invitar' }]} />
        <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <p style={{ color: 'var(--muted)' }}>{loadError}</p>
        </main>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Header breadcrumb={[{ label: slug ?? '', href: '/' }, { label: 'invitar' }]} />
      <main style={{ flex: 1, padding: '48px 24px 64px' }}>
        <div
          style={{
            maxWidth: 960,
            margin: '0 auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 40,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
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
              Invita al parche
            </h1>
            <p style={{ margin: 0, fontSize: 15, color: 'var(--muted)' }}>
              Pásale el comando a tu equipo. Lo corren desde el editor y quedan dentro.
            </p>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 32, alignItems: 'flex-start' }}>
            {/* Left: code/command/link display */}
            <section
              aria-label="Invitación"
              style={{
                flex: '999 1 520px',
                minWidth: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 20,
              }}
            >
              {newInvite ? (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--muted)' }}>
                      Código
                    </span>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 16,
                        flexWrap: 'wrap',
                        padding: '20px 24px',
                        border: '1px solid var(--border)',
                        borderRadius: 6,
                        background: 'var(--bg2)',
                      }}
                    >
                      <span
                        style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 44,
                          fontWeight: 500,
                          letterSpacing: '0.08em',
                          lineHeight: 1,
                        }}
                      >
                        {code}
                      </span>
                      <CopyButton text={code} label="Copiar" copiedLabel="Copiado" />
                    </div>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--muted)' }}>
                      Comando
                    </span>
                    <CodeBlock
                      command={command}
                      onCopy={() => cmdCopy.copy(command)}
                      copied={cmdCopy.copied}
                      copyLabel="Copiar comando"
                      copiedLabel="Copiado"
                      variant="primary"
                    />
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--muted)' }}>
                      Link
                    </span>
                    {/* Same responsive shell as CodeBlock (.code-block): one row on desktop,
                        stacked with the URL wrapping on narrow screens, so it is never clipped. */}
                    <div className="code-block link-row">
                      <code>{fullLink}</code>
                      <button
                        type="button"
                        onClick={() => linkCopy.copy(fullLink)}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '0 14px',
                          background: 'var(--bg2)',
                          color: 'var(--text)',
                          fontSize: 13,
                          fontWeight: 500,
                          cursor: 'pointer',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {linkCopy.copied ? 'Copiado' : 'Copiar link'}
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: 200,
                    border: '1px dashed var(--border)',
                    borderRadius: 6,
                  }}
                >
                  <p style={{ color: 'var(--muted)', fontSize: 14 }}>
                    Genera una invitación con el formulario →
                  </p>
                </div>
              )}
            </section>

            {/* Right: options form */}
            <section
              aria-label="Opciones de la invitación"
              style={{
                flex: '1 1 280px',
                minWidth: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 20,
                padding: 20,
                border: '1px solid var(--border)',
                borderRadius: 6,
              }}
            >
              <form
                onSubmit={handleCreate}
                style={{ display: 'flex', flexDirection: 'column', gap: 20 }}
              >
                <fieldset
                  style={{
                    border: 0,
                    padding: 0,
                    margin: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  <legend
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      padding: 0,
                      float: 'left',
                      width: '100%',
                    }}
                  >
                    Rol
                  </legend>
                  <div
                    style={{
                      display: 'flex',
                      padding: 3,
                      gap: 3,
                      border: '1px solid var(--border)',
                      borderRadius: 5,
                      background: 'var(--bg)',
                    }}
                  >
                    {(['admin', 'editor', 'reader'] as const).map((r) => (
                      <button
                        key={r}
                        type="button"
                        aria-pressed={role === r}
                        onClick={() => setRole(r)}
                        style={{
                          flex: 1,
                          height: 30,
                          padding: '0 10px',
                          borderRadius: 3,
                          fontSize: 13,
                          fontWeight: 500,
                          cursor: 'pointer',
                          border: role === r ? '1px solid var(--border)' : '1px solid transparent',
                          background: role === r ? 'var(--card)' : 'transparent',
                          color: role === r ? 'var(--text)' : 'var(--muted)',
                        }}
                      >
                        {ROLE_LABELS[r]}
                      </button>
                    ))}
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>{ROLE_HINTS[role]}</span>
                </fieldset>

                <fieldset
                  style={{
                    border: 0,
                    padding: 0,
                    margin: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  <legend
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      padding: 0,
                      float: 'left',
                      width: '100%',
                    }}
                  >
                    Expira
                  </legend>
                  <div
                    style={{
                      display: 'flex',
                      padding: 3,
                      gap: 3,
                      border: '1px solid var(--border)',
                      borderRadius: 5,
                      background: 'var(--bg)',
                    }}
                  >
                    {(
                      [
                        ['24h', '24 h'],
                        ['7d', '7 días'],
                        ['never', 'Nunca'],
                      ] as const
                    ).map(([val, label]) => (
                      <button
                        key={val}
                        type="button"
                        aria-pressed={expires === val}
                        onClick={() => setExpires(val)}
                        style={{
                          flex: 1,
                          height: 30,
                          padding: '0 10px',
                          borderRadius: 3,
                          fontSize: 13,
                          fontWeight: 500,
                          cursor: 'pointer',
                          border:
                            expires === val ? '1px solid var(--border)' : '1px solid transparent',
                          background: expires === val ? 'var(--card)' : 'transparent',
                          color: expires === val ? 'var(--text)' : 'var(--muted)',
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </fieldset>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <label htmlFor="usos" style={{ fontSize: 13, fontWeight: 500 }}>
                    Usos máximos
                  </label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <input
                      id="usos"
                      type="number"
                      min="1"
                      value={maxUses}
                      onChange={(e) => setMaxUses(e.target.value)}
                      placeholder="∞"
                      style={{
                        width: 88,
                        height: 36,
                        padding: '0 10px',
                        border: '1px solid var(--border)',
                        borderRadius: 5,
                        background: 'var(--bg2)',
                        color: 'var(--text)',
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 13,
                        outline: 'none',
                      }}
                    />
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>Vacío = sin límite</span>
                  </div>
                </div>

                {createError && (
                  <p role="alert" style={{ margin: 0, fontSize: 13, color: 'var(--warn)' }}>
                    {createError}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={creating}
                  style={{
                    height: 36,
                    borderRadius: 5,
                    border: '1px solid var(--border)',
                    background: 'transparent',
                    color: 'var(--text)',
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  {creating ? 'Generando…' : 'Generar código'}
                </button>
              </form>
            </section>
          </div>

          {/* Invites list */}
          <section
            aria-labelledby="h-activas"
            style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <h2
                id="h-activas"
                style={{
                  margin: 0,
                  fontFamily: "'Space Grotesk', sans-serif",
                  fontWeight: 600,
                  fontSize: 18,
                }}
              >
                Invitaciones activas{' '}
                <span
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 13,
                    fontWeight: 400,
                    color: 'var(--muted)',
                  }}
                >
                  {invites.length}
                </span>
              </h2>
            </div>
            {revokeError && (
              <p role="alert" style={{ margin: 0, fontSize: 13, color: 'var(--warn)' }}>
                {revokeError}
              </p>
            )}
            {/* Desktop table — hidden below 640 px */}
            <div
              className="invite-table-desktop"
              style={{ border: '1px solid var(--border)', borderRadius: 6, overflowX: 'auto' }}
            >
              <div style={{ minWidth: 640 }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '150px 80px 1fr 80px 1fr 96px',
                    gap: 16,
                    alignItems: 'center',
                    height: 36,
                    padding: '0 16px',
                    borderBottom: '1px solid var(--border)',
                    fontSize: 12,
                    color: 'var(--muted)',
                  }}
                >
                  <span>Código</span>
                  <span>Rol</span>
                  <span>Expira</span>
                  <span>Usos</span>
                  <span>Creada por</span>
                  <span />
                </div>
                {invites.length === 0 ? (
                  <div style={{ padding: '20px 16px', fontSize: 14, color: 'var(--muted)' }}>
                    No hay invitaciones activas.
                  </div>
                ) : (
                  invites.map((inv) => (
                    <div
                      key={inv.id}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '150px 80px 1fr 80px 1fr 96px',
                        gap: 16,
                        alignItems: 'center',
                        height: 48,
                        padding: '0 16px',
                        borderBottom: '1px solid var(--border)',
                        fontSize: 14,
                      }}
                    >
                      <code style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13 }}>
                        {inv.codeDisplay}
                      </code>
                      <span>{ROLE_LABELS[inv.role] ?? inv.role}</span>
                      <span
                        style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 12,
                          color: 'var(--muted)',
                        }}
                      >
                        {inv.expiresAt ? new Date(inv.expiresAt).toLocaleDateString('es') : 'nunca'}
                      </span>
                      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
                        {inv.uses}/{inv.maxUses ?? '∞'}
                      </span>
                      <span style={{ color: 'var(--muted)' }}>{inv.createdBy}</span>
                      <button
                        type="button"
                        onClick={() => handleRevoke(inv.id)}
                        disabled={revoking === inv.id}
                        aria-label={`Revocar invitación ${inv.codeDisplay}`}
                        style={{
                          justifySelf: 'end',
                          height: 30,
                          padding: '0 10px',
                          borderRadius: 5,
                          border: '1px solid var(--border)',
                          background: 'transparent',
                          color: 'var(--text)',
                          fontSize: 13,
                          cursor: 'pointer',
                        }}
                      >
                        Revocar
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Mobile card list — shown below 640 px */}
            <div
              className="invite-list-mobile"
              style={{ border: '1px solid var(--border)', borderRadius: 6 }}
            >
              {invites.length === 0 ? (
                <div style={{ padding: '20px 14px', fontSize: 14, color: 'var(--muted)' }}>
                  No hay invitaciones activas.
                </div>
              ) : (
                invites.map((inv) => (
                  <div key={`m-${inv.id}`} className="invite-mobile-row">
                    <span className="invite-mobile-info">
                      <code style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 14 }}>
                        {inv.codeDisplay}
                      </code>
                      <span
                        style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 12,
                          color: 'var(--muted)',
                        }}
                      >
                        {ROLE_LABELS[inv.role] ?? inv.role} · {inv.uses}/{inv.maxUses ?? '∞'} ·{' '}
                        {inv.expiresAt
                          ? new Date(inv.expiresAt).toLocaleDateString('es')
                          : 'nunca expira'}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => handleRevoke(inv.id)}
                      disabled={revoking === inv.id}
                      aria-label={`Revocar invitación ${inv.codeDisplay}`}
                      style={{
                        flexShrink: 0,
                        height: 44,
                        padding: '0 14px',
                        borderRadius: 5,
                        border: '1px solid var(--border)',
                        background: 'transparent',
                        color: 'var(--text)',
                        fontSize: 14,
                        cursor: 'pointer',
                      }}
                    >
                      Revocar
                    </button>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
