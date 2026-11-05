/** Miembros page: /g/:slug/miembros
 *  Tabla de miembros y dispositivos del parche.
 *  Layout: header + contenedor max 1000px
 *  Responsive: 1280px = tabla 4 col; 639px = tarjetas apiladas
 */

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type MemberRow } from '../api.ts';
import { ConfirmDialog } from '../components/confirm-dialog.tsx';
import { Header } from '../components/header.tsx';
import { avatarBg, timeAgo } from '../lib/time.ts';

type LoadState = 'loading' | 'loaded' | 'error' | '404';

// ─── Frontend permission helpers ─────────────────────────────────────────────
// Replica las reglas de src/auth/member-permissions.ts para decidir qué
// controles mostrar. El backend sigue siendo la autoridad de seguridad.

type Role = 'owner' | 'admin' | 'editor' | 'reader';

/** ¿Puede viewer cambiar el rol del miembro target? */
function canViewerChangeRole(viewerRole: Role, targetRole: Role): boolean {
  if (targetRole === 'owner') return false; // nunca demotear al único owner
  if (viewerRole === 'owner') return true;
  if (viewerRole === 'admin') return true; // admin puede cambiar admin/editor/reader
  return false;
}

/** ¿Puede viewer quitar al miembro target?
 *  - owner y admin pueden quitar a cualquiera, incluidos a sí mismos (admin self-remove).
 *  - owner queda bloqueado por la regla de último owner en el backend (409 last_owner).
 *  - targetRole === 'owner' oculta el botón: no hay manera de quitar al único owner desde la UI. */
function canViewerRemove(viewerRole: Role, targetRole: Role): boolean {
  if (targetRole === 'owner') return false;
  if (viewerRole === 'owner') return true;
  if (viewerRole === 'admin') return true;
  return false;
}

/** ¿Puede viewer revocar un dispositivo de deviceOwner con rol deviceOwnerRole? */
function canViewerRevokeDevice(
  viewerRole: Role,
  viewerId: string,
  deviceOwnerId: string,
  deviceOwnerRole: Role,
): boolean {
  if (viewerId === deviceOwnerId) return true; // siempre propio
  if (viewerRole === 'owner') return true;
  if (viewerRole === 'admin' && deviceOwnerRole !== 'owner') return true;
  return false;
}

/** ¿Debe mostrarse el aviso "se unió pero no ha sincronizado"?
 *  Condición: ningún dispositivo activo tiene lastSeenAt (incluye lista vacía) */
function neverSynced(devices: MemberRow['devices']): boolean {
  return devices.every((d) => d.lastSeenAt === null || d.revokedAt !== null);
}

// ─── Tipos de diálogo de confirmación ────────────────────────────────────────

type ConfirmState =
  | { kind: 'remove'; userId: string; name: string }
  | { kind: 'revoke'; deviceId: string; label: string };

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  editor: 'Editor',
  reader: 'Lector',
};

// Monitor icon SVG inline
const MonitorIcon = () => (
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
    <rect x="3" y="4" width="18" height="12" rx="1.5" />
    <path d="M2 20h20" />
  </svg>
);

// ─── Main page ────────────────────────────────────────────────────────────────

export function MiembrosPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();

  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [myRole, setMyRole] = useState<Role>('reader');
  const [myId, setMyId] = useState<string>('');
  const [groupName, setGroupName] = useState('');
  // errorMsg reserved for future top-level load errors; not yet rendered

  // Estado de confirmación
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [actionError, setActionError] = useState('');

  // Estado de cambio de rol (mensaje de error por miembro)
  const [roleErrors, setRoleErrors] = useState<Record<string, string>>({});

  // Función para (re)cargar datos
  const loadData = (currentSlug: string) => {
    Promise.all([api.getMe(), api.getMembers(currentSlug)])
      .then(([me, rows]) => {
        setMyId(me.user.id);
        const myGroup = me.groups.find((g) => g.slug === currentSlug);
        if (myGroup) {
          setMyRole(myGroup.role as Role);
          setGroupName(myGroup.name);
        }
        setMembers(rows);
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
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: loadData is redefined each render; stable per slug only
  useEffect(() => {
    if (!slug) return;
    loadData(slug);
  }, [slug]);

  // ─── Handlers ──────────────────────────────────────────────────────────────

  async function handleRoleChange(userId: string, newRole: string) {
    if (!slug) return;
    setRoleErrors((prev) => ({ ...prev, [userId]: '' }));
    try {
      await api.changeMemberRole(slug, userId, newRole);
      loadData(slug);
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      const body = (err as { body?: { error?: string } }).body;
      let msg = 'Error al cambiar el rol.';
      if (status === 409 && body?.error === 'last_owner') {
        msg = 'No puedes dejar el parche sin owner.';
      } else if (status === 403) {
        msg = 'No tienes permiso para esto.';
      }
      setRoleErrors((prev) => ({ ...prev, [userId]: msg }));
    }
  }

  async function handleConfirm() {
    if (!confirm || !slug) return;
    setConfirming(true);
    setActionError('');
    try {
      if (confirm.kind === 'remove') {
        await api.removeMember(slug, confirm.userId);
        setConfirm(null);
        // Si el viewer se quitó a sí mismo, ya no tiene acceso: ir a inicio
        if (confirm.userId === myId) {
          navigate('/inicio', { replace: true });
          return;
        }
      } else {
        await api.revokeDevice(slug, confirm.deviceId);
        setConfirm(null);
      }
      loadData(slug);
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      const body = (err as { body?: { error?: string } }).body;
      let msg = 'Ocurrió un error. Inténtalo de nuevo.';
      if (status === 409 && body?.error === 'last_owner') {
        msg = 'No puedes dejar el parche sin owner.';
      } else if (status === 403) {
        msg = 'No tienes permiso para esto.';
      }
      setActionError(msg);
      setConfirm(null);
    } finally {
      setConfirming(false);
    }
  }

  // ─── Contadores para subtítulo ──────────────────────────────────────────────
  // Solo dispositivos activos: los revocados se listan atenuados pero no cuentan
  const totalDevices = members.reduce(
    (acc, m) => acc + m.devices.filter((d) => d.revokedAt === null).length,
    0,
  );
  const isOwnerOrAdmin = myRole === 'owner' || myRole === 'admin';

  // ─── Render early states ───────────────────────────────────────────────────

  if (loadState === '404') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Header breadcrumb={[{ label: slug ?? '' }, { label: 'miembros' }]} />
        <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <p style={{ color: 'var(--muted)' }}>Parche no encontrado.</p>
        </main>
      </div>
    );
  }

  if (loadState === 'error') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Header breadcrumb={[{ label: slug ?? '' }, { label: 'miembros' }]} />
        <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <p style={{ color: 'var(--muted)' }}>Error al cargar los miembros.</p>
        </main>
      </div>
    );
  }

  if (loadState === 'loading') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Header breadcrumb={[{ label: slug ?? '', href: `/g/${slug}` }, { label: 'miembros' }]} />
        <main style={{ flex: 1 }} />
      </div>
    );
  }

  // ─── Confirm dialog copy ──────────────────────────────────────────────────

  const dialogMessage = confirm
    ? confirm.kind === 'remove'
      ? confirm.userId === myId
        ? '¿Salir del parche? Pierdes acceso y se revocan tus dispositivos; lo que guardaste se queda.'
        : `¿Quitar a ${confirm.name} del parche? Pierde acceso y se revocan sus dispositivos; lo que guardó se queda.`
      : `¿Revocar ${confirm.label}? Su sync se corta al instante; lo que ya guardó se queda.`
    : '';

  const dialogConfirmLabel = confirm
    ? confirm.kind === 'remove'
      ? 'Quitar'
      : 'Revocar'
    : 'Confirmar';

  // ─── Full render ───────────────────────────────────────────────────────────

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Header
        breadcrumb={[
          { label: groupName || (slug ?? ''), href: `/g/${slug}` },
          { label: 'miembros' },
        ]}
      />

      <main style={{ flex: 1, padding: '40px 24px 64px' }}>
        <div
          style={{
            maxWidth: 1000,
            margin: '0 auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 24,
          }}
        >
          {/* ── Hero row ── */}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'flex-end',
              justifyContent: 'space-between',
              gap: 16,
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
                Miembros y dispositivos
              </h1>
              <span
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 12,
                  color: 'var(--muted)',
                }}
              >
                {members.length} miembro{members.length !== 1 ? 's' : ''} · {totalDevices}{' '}
                dispositivo{totalDevices !== 1 ? 's' : ''}
              </span>
            </div>

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
                Invitar al parche
              </Link>
            )}
          </div>

          {/* Error de acción global */}
          {actionError && (
            <p role="alert" style={{ margin: 0, fontSize: 13, color: 'var(--warn-text)' }}>
              {actionError}
            </p>
          )}

          {/* ── Desktop table ── */}
          <div
            className="invite-table-desktop"
            style={{
              border: '1px solid var(--border)',
              borderRadius: 6,
              overflowX: 'auto',
            }}
          >
            <div style={{ minWidth: 760 }}>
              {/* Header row */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0,1fr) 140px 200px 104px',
                  gap: 16,
                  alignItems: 'center',
                  height: 36,
                  padding: '0 16px',
                  borderBottom: '1px solid var(--border)',
                  fontSize: 12,
                  color: 'var(--muted)',
                }}
              >
                <span>Miembro</span>
                <span>Rol</span>
                <span>Último sync</span>
                <span />
              </div>

              {members.map((m, idx) => {
                const avatarSrc = m.user.email ?? m.user.name;
                const initial = m.user.name[0]?.toUpperCase() ?? '?';
                const memberRole = m.role as Role;
                const showRoleSelect = canViewerChangeRole(myRole, memberRole);
                const showRemove = canViewerRemove(myRole, memberRole);
                const isLast = idx === members.length - 1;

                // Ultimo sync
                const syncLabel = m.lastSyncAt
                  ? timeAgo(m.lastSyncAt)
                  : m.devices.some((d) => d.revokedAt === null)
                    ? 'sin sync'
                    : m.devices.length === 0
                      ? 'sin dispositivos'
                      : 'sin dispositivos activos';
                const syncColor = m.lastSyncAt ? 'var(--ok-text)' : 'var(--muted)';

                // Aviso no-sync
                const showNoSync = neverSynced(m.devices);

                return (
                  <div
                    key={m.user.id}
                    style={{
                      borderBottom: isLast ? 'none' : '1px solid var(--border)',
                    }}
                  >
                    {/* Fila del miembro */}
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'minmax(0,1fr) 140px 200px 104px',
                        gap: 16,
                        alignItems: 'center',
                        padding: '14px 16px',
                      }}
                    >
                      {/* Miembro: avatar + nombre + email */}
                      <span
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 12,
                          minWidth: 0,
                        }}
                      >
                        <span
                          aria-hidden="true"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            width: 32,
                            height: 32,
                            borderRadius: 4,
                            background: avatarBg(avatarSrc),
                            fontFamily: "'JetBrains Mono', monospace",
                            fontSize: 12,
                            flexShrink: 0,
                          }}
                        >
                          {initial}
                        </span>
                        <span
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 2,
                            minWidth: 0,
                          }}
                        >
                          <span style={{ fontSize: 14, fontWeight: 600 }}>
                            {m.user.name}
                            {m.isYou && (
                              <span
                                style={{ fontWeight: 400, color: 'var(--muted)', marginLeft: 6 }}
                              >
                                (tú)
                              </span>
                            )}
                          </span>
                          {m.user.email && (
                            <span
                              style={{
                                fontFamily: "'JetBrains Mono', monospace",
                                fontSize: 12,
                                color: 'var(--muted)',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {m.user.email}
                            </span>
                          )}
                        </span>
                      </span>

                      {/* Rol */}
                      {showRoleSelect ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <select
                            aria-label={`Rol de ${m.user.name}`}
                            value={memberRole}
                            onChange={(e) => handleRoleChange(m.user.id, e.target.value)}
                            style={{
                              height: 32,
                              padding: '0 8px',
                              border: '1px solid var(--border)',
                              borderRadius: 5,
                              background: 'var(--bg2)',
                              color: 'var(--text)',
                              fontSize: 13,
                            }}
                          >
                            <option value="admin">Admin</option>
                            <option value="editor">Editor</option>
                            <option value="reader">Lector</option>
                          </select>
                          {roleErrors[m.user.id] && (
                            <span role="alert" style={{ fontSize: 11, color: 'var(--warn-text)' }}>
                              {roleErrors[m.user.id]}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span style={{ fontSize: 14 }}>
                          {ROLE_LABELS[memberRole] ?? memberRole}
                        </span>
                      )}

                      {/* Último sync */}
                      <span
                        style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 12,
                          color: syncColor,
                        }}
                      >
                        {syncLabel}
                      </span>

                      {/* Quitar */}
                      {showRemove ? (
                        <button
                          type="button"
                          onClick={() =>
                            setConfirm({ kind: 'remove', userId: m.user.id, name: m.user.name })
                          }
                          aria-label={`Quitar a ${m.user.name} del parche`}
                          style={{
                            justifySelf: 'end',
                            height: 28,
                            padding: '0 10px',
                            borderRadius: 5,
                            border: '1px solid var(--border)',
                            background: 'transparent',
                            color: 'var(--text)',
                            fontSize: 12,
                            cursor: 'pointer',
                          }}
                        >
                          Quitar
                        </button>
                      ) : (
                        <span />
                      )}
                    </div>

                    {/* Dispositivos anidados */}
                    {m.devices.map((d) => {
                      const isRevoked = d.revokedAt !== null;
                      const showRevoke =
                        !isRevoked && canViewerRevokeDevice(myRole, myId, m.user.id, memberRole);

                      return (
                        <div
                          key={d.id}
                          style={{
                            display: 'grid',
                            gridTemplateColumns: 'minmax(0,1fr) 140px 200px 104px',
                            gap: 16,
                            alignItems: 'center',
                            padding: '8px 16px 8px 60px',
                            fontSize: 13,
                            opacity: isRevoked ? 0.5 : 1,
                          }}
                        >
                          {/* Label + id corto */}
                          <span
                            style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}
                          >
                            <span style={{ color: 'var(--muted)', flexShrink: 0 }}>
                              <MonitorIcon />
                            </span>
                            <span
                              style={{
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {d.label}
                            </span>
                            <code
                              style={{
                                fontFamily: "'JetBrains Mono', monospace",
                                fontSize: 11,
                                color: 'var(--muted)',
                                flexShrink: 0,
                              }}
                            >
                              {d.id.slice(0, 8)}
                            </code>
                            {isRevoked && (
                              <span
                                style={{
                                  fontSize: 11,
                                  color: 'var(--muted)',
                                  border: '1px solid var(--border)',
                                  borderRadius: 3,
                                  padding: '0 5px',
                                  flexShrink: 0,
                                }}
                              >
                                revocado
                              </span>
                            )}
                          </span>

                          {/* col rol (vacía para dispositivos) */}
                          <span />

                          {/* lastSeenAt */}
                          <span
                            style={{
                              fontFamily: "'JetBrains Mono', monospace",
                              fontSize: 12,
                              color: 'var(--muted)',
                            }}
                          >
                            {d.lastSeenAt ? timeAgo(d.lastSeenAt) : '—'}
                          </span>

                          {/* Revocar */}
                          {showRevoke ? (
                            <button
                              type="button"
                              onClick={() =>
                                setConfirm({ kind: 'revoke', deviceId: d.id, label: d.label })
                              }
                              aria-label={`Revocar ${d.label}`}
                              style={{
                                justifySelf: 'end',
                                height: 28,
                                padding: '0 10px',
                                borderRadius: 5,
                                border: '1px solid var(--border)',
                                background: 'transparent',
                                color: 'var(--text)',
                                fontSize: 12,
                                cursor: 'pointer',
                              }}
                            >
                              Revocar
                            </button>
                          ) : (
                            <span />
                          )}
                        </div>
                      );
                    })}

                    {/* Aviso no-sync */}
                    {showNoSync && (
                      <p
                        style={{
                          margin: 0,
                          padding: '0 16px 14px 60px',
                          fontSize: 13,
                          color: 'var(--muted)',
                        }}
                      >
                        Se unió pero no ha sincronizado. Pídele que corra{' '}
                        <code
                          style={{
                            fontFamily: "'JetBrains Mono', monospace",
                            fontSize: 12,
                          }}
                        >
                          npx @chamba/mcp vault sync
                        </code>
                        .
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Mobile card list ── */}
          <div
            className="invite-list-mobile"
            style={{ border: '1px solid var(--border)', borderRadius: 6 }}
          >
            {members.map((m, idx) => {
              const avatarSrc = m.user.email ?? m.user.name;
              const initial = m.user.name[0]?.toUpperCase() ?? '?';
              const memberRole = m.role as Role;
              const showRoleSelect = canViewerChangeRole(myRole, memberRole);
              const showRemove = canViewerRemove(myRole, memberRole);
              const isLast = idx === members.length - 1;
              const showNoSync = neverSynced(m.devices);

              const syncLabel = m.lastSyncAt
                ? timeAgo(m.lastSyncAt)
                : m.devices.some((d) => d.revokedAt === null)
                  ? 'sin sync'
                  : m.devices.length === 0
                    ? 'sin dispositivos'
                    : 'sin dispositivos activos';
              const syncColor = m.lastSyncAt ? 'var(--ok-text)' : 'var(--muted)';

              return (
                <div
                  key={`m-${m.user.id}`}
                  style={{
                    borderBottom: isLast ? 'none' : '1px solid var(--border)',
                    padding: '14px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                  }}
                >
                  {/* Avatar + info row */}
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                    <span
                      aria-hidden="true"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 36,
                        height: 36,
                        borderRadius: 4,
                        background: avatarBg(avatarSrc),
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 13,
                        flexShrink: 0,
                      }}
                    >
                      {initial}
                    </span>
                    <div
                      style={{
                        flex: 1,
                        minWidth: 0,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                      }}
                    >
                      <span style={{ fontSize: 15, fontWeight: 600 }}>
                        {m.user.name}
                        {m.isYou && (
                          <span style={{ fontWeight: 400, color: 'var(--muted)', marginLeft: 6 }}>
                            (tú)
                          </span>
                        )}
                      </span>
                      {m.user.email && (
                        <span
                          style={{
                            fontFamily: "'JetBrains Mono', monospace",
                            fontSize: 12,
                            color: 'var(--muted)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {m.user.email}
                        </span>
                      )}
                      <div
                        style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
                      >
                        {showRoleSelect ? (
                          <select
                            aria-label={`Rol de ${m.user.name}`}
                            value={memberRole}
                            onChange={(e) => handleRoleChange(m.user.id, e.target.value)}
                            style={{
                              height: 36,
                              padding: '0 8px',
                              border: '1px solid var(--border)',
                              borderRadius: 5,
                              background: 'var(--bg2)',
                              color: 'var(--text)',
                              fontSize: 14,
                            }}
                          >
                            <option value="admin">Admin</option>
                            <option value="editor">Editor</option>
                            <option value="reader">Lector</option>
                          </select>
                        ) : (
                          <span
                            style={{
                              fontSize: 13,
                              color: 'var(--muted)',
                              border: '1px solid var(--border)',
                              borderRadius: 4,
                              padding: '2px 8px',
                            }}
                          >
                            {ROLE_LABELS[memberRole] ?? memberRole}
                          </span>
                        )}
                        <span
                          style={{
                            fontFamily: "'JetBrains Mono', monospace",
                            fontSize: 12,
                            color: syncColor,
                          }}
                        >
                          {syncLabel}
                        </span>
                      </div>
                      {roleErrors[m.user.id] && (
                        <span role="alert" style={{ fontSize: 12, color: 'var(--warn-text)' }}>
                          {roleErrors[m.user.id]}
                        </span>
                      )}
                    </div>
                    {showRemove && (
                      <button
                        type="button"
                        onClick={() =>
                          setConfirm({ kind: 'remove', userId: m.user.id, name: m.user.name })
                        }
                        aria-label={`Quitar a ${m.user.name} del parche`}
                        style={{
                          height: 44,
                          padding: '0 14px',
                          borderRadius: 5,
                          border: '1px solid var(--border)',
                          background: 'transparent',
                          color: 'var(--text)',
                          fontSize: 14,
                          cursor: 'pointer',
                          flexShrink: 0,
                        }}
                      >
                        Quitar
                      </button>
                    )}
                  </div>

                  {/* Dispositivos */}
                  {m.devices.length > 0 && (
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                        paddingLeft: 48,
                      }}
                    >
                      {m.devices.map((d) => {
                        const isRevoked = d.revokedAt !== null;
                        const showRevoke =
                          !isRevoked && canViewerRevokeDevice(myRole, myId, m.user.id, memberRole);

                        return (
                          <div
                            key={d.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              opacity: isRevoked ? 0.5 : 1,
                              flexWrap: 'wrap',
                            }}
                          >
                            <span style={{ color: 'var(--muted)', flexShrink: 0 }}>
                              <MonitorIcon />
                            </span>
                            <span style={{ fontSize: 13, minWidth: 0 }}>{d.label}</span>
                            <code
                              style={{
                                fontFamily: "'JetBrains Mono', monospace",
                                fontSize: 11,
                                color: 'var(--muted)',
                                wordBreak: 'break-all',
                              }}
                            >
                              {d.id.slice(0, 8)}
                            </code>
                            {isRevoked && (
                              <span
                                style={{
                                  fontSize: 11,
                                  color: 'var(--muted)',
                                  border: '1px solid var(--border)',
                                  borderRadius: 3,
                                  padding: '0 5px',
                                }}
                              >
                                revocado
                              </span>
                            )}
                            <span
                              style={{
                                fontFamily: "'JetBrains Mono', monospace",
                                fontSize: 12,
                                color: 'var(--muted)',
                              }}
                            >
                              {d.lastSeenAt ? timeAgo(d.lastSeenAt) : '—'}
                            </span>
                            {showRevoke && (
                              <button
                                type="button"
                                onClick={() =>
                                  setConfirm({ kind: 'revoke', deviceId: d.id, label: d.label })
                                }
                                aria-label={`Revocar ${d.label}`}
                                style={{
                                  height: 36,
                                  padding: '0 12px',
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
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Aviso no-sync */}
                  {showNoSync && (
                    <p
                      style={{
                        margin: 0,
                        paddingLeft: 48,
                        fontSize: 13,
                        color: 'var(--muted)',
                      }}
                    >
                      Se unió pero no ha sincronizado. Pídele que corra{' '}
                      <code style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
                        npx @chamba/mcp vault sync
                      </code>
                      .
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          {/* Nota al pie */}
          <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
            Revocar un dispositivo corta su sync al instante. Las notas que ya guardó se quedan en
            el parche.
          </p>
        </div>
      </main>

      {/* Diálogo de confirmación */}
      {confirm && (
        <ConfirmDialog
          message={dialogMessage}
          confirmLabel={dialogConfirmLabel}
          confirming={confirming}
          onConfirm={handleConfirm}
          onCancel={() => {
            setConfirm(null);
            setActionError('');
          }}
        />
      )}
    </div>
  );
}
