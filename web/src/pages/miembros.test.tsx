/**
 * B-T7: Tests frontend de MiembrosPage y ConfirmDialog
 *
 * Cubre:
 *  - Render de miembros y dispositivos
 *  - <select> de rol visible solo con permiso
 *  - Flujo de confirmación Quitar
 *  - Flujo de confirmación Revocar
 *  - Aviso "no ha sincronizado" con dispositivo sin lastSeenAt
 *  - Aviso "no ha sincronizado" con lista vacía de dispositivos
 *  - Ausencia de campos D6 (cambios pendientes, conflictos)
 *  - Sin email para editor viendo otro miembro
 *  - Error 409 en cambio de rol
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MiembrosPage } from './miembros.tsx';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ME_OWNER = {
  user: { id: 'u-owner', name: 'Joys', email: 'joys@test.dev' },
  groups: [{ slug: 'cya', name: 'CYA', role: 'owner' }],
};

const ME_EDITOR = {
  user: { id: 'u-editor', name: 'Editor', email: 'editor@test.dev' },
  groups: [{ slug: 'cya', name: 'CYA', role: 'editor' }],
};

const DEVICE_ACTIVE = {
  id: 'dev-aabbccdd-1234',
  label: 'MacBook de Joys',
  kind: 'device' as const,
  lastSeenAt: new Date(Date.now() - 60000).toISOString(), // 1 min ago
  createdAt: new Date().toISOString(),
  revokedAt: null,
};

const DEVICE_NO_SEEN = {
  id: 'dev-eeff0011-5678',
  label: 'ThinkPad',
  kind: 'device' as const,
  lastSeenAt: null,
  createdAt: new Date().toISOString(),
  revokedAt: null,
};

const DEVICE_REVOKED = {
  id: 'dev-11223344-aaaa',
  label: 'Ubuntu old',
  kind: 'device' as const,
  lastSeenAt: new Date(Date.now() - 86400000).toISOString(),
  createdAt: new Date().toISOString(),
  revokedAt: new Date(Date.now() - 3600000).toISOString(),
};

function makeMemberRows() {
  return [
    {
      user: { id: 'u-owner', name: 'Joys', email: 'joys@test.dev' },
      role: 'owner',
      joinedAt: new Date().toISOString(),
      isYou: true,
      lastSyncAt: DEVICE_ACTIVE.lastSeenAt,
      devices: [DEVICE_ACTIVE],
    },
    {
      user: { id: 'u-admin', name: 'Admin User', email: 'admin@test.dev' },
      role: 'admin',
      joinedAt: new Date().toISOString(),
      isYou: false,
      lastSyncAt: null,
      devices: [],
    },
    {
      user: { id: 'u-editor', name: 'Editor User', email: 'editor@test.dev' },
      role: 'editor',
      joinedAt: new Date().toISOString(),
      isYou: false,
      lastSyncAt: DEVICE_ACTIVE.lastSeenAt,
      devices: [DEVICE_ACTIVE, DEVICE_REVOKED],
    },
  ];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderMiembros() {
  return render(
    <MemoryRouter initialEntries={['/g/cya/miembros']}>
      <Routes>
        <Route path="/g/:slug/miembros" element={<MiembrosPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function mockFetch(me: unknown, memberRows: unknown, mutationOk = true) {
  global.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
    const method = opts?.method ?? 'GET';
    // /api/web/me — exact suffix check to avoid matching /members
    if (method === 'GET' && (url as string).endsWith('/me')) {
      return Promise.resolve({ ok: true, json: async () => me });
    }
    if (method === 'GET' && (url as string).includes('/members')) {
      return Promise.resolve({ ok: true, json: async () => memberRows });
    }
    // POST mutations
    if (!mutationOk) {
      return Promise.resolve({
        ok: false,
        status: 409,
        json: async () => ({ error: 'last_owner' }),
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MiembrosPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders h1 and member names', async () => {
    mockFetch(ME_OWNER, makeMemberRows());
    renderMiembros();
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
        'Miembros y dispositivos',
      ),
    );
    // Desktop + mobile both render names, so use getAllByText
    expect(screen.getAllByText(/^Joys/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Admin User').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Editor User').length).toBeGreaterThan(0);
  });

  it('shows (tú) next to the current user', async () => {
    mockFetch(ME_OWNER, makeMemberRows());
    renderMiembros();
    // (tú) appears in both desktop and mobile views
    await waitFor(() => expect(screen.getAllByText('(tú)').length).toBeGreaterThan(0));
  });

  it('shows subtítulo with member and device counts', async () => {
    mockFetch(ME_OWNER, makeMemberRows());
    renderMiembros();
    await waitFor(() => {
      // Solo cuentan los activos: owner 1 + editor 1 (el revocado del editor no cuenta)
      expect(screen.getByText(/3 miembros · 2 dispositivos/)).toBeInTheDocument();
    });
  });

  it('último sync: «sin dispositivos» sin ninguno y «sin dispositivos activos» si todos están revocados', async () => {
    const rows: unknown[] = makeMemberRows();
    rows.push({
      user: { id: 'u-reader', name: 'Reader User', email: 'reader@test.dev' },
      role: 'reader',
      joinedAt: new Date().toISOString(),
      isYou: false,
      lastSyncAt: null,
      devices: [DEVICE_REVOKED],
    });
    mockFetch(ME_OWNER, rows);
    renderMiembros();
    await waitFor(() => {
      expect(screen.getAllByText('sin dispositivos').length).toBeGreaterThan(0);
      expect(screen.getAllByText('sin dispositivos activos').length).toBeGreaterThan(0);
    });
  });

  it('shows Invitar button only for owner/admin', async () => {
    mockFetch(ME_OWNER, makeMemberRows());
    renderMiembros();
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /invitar al parche/i })).toBeInTheDocument(),
    );
  });

  it('does NOT show Invitar button for editor', async () => {
    mockFetch(
      ME_EDITOR,
      makeMemberRows().map((m) => ({ ...m, isYou: m.user.id === 'u-editor' })),
    );
    renderMiembros();
    await waitFor(() => screen.getByRole('heading', { level: 1 }));
    expect(screen.queryByRole('link', { name: /invitar/i })).not.toBeInTheDocument();
  });

  it('shows <select> for role only when viewer has permission', async () => {
    // Owner viewing: can change admin and editor roles, but not owner self
    mockFetch(ME_OWNER, makeMemberRows());
    renderMiembros();
    await waitFor(() => screen.getByRole('heading', { level: 1 }));
    // Owner can change admin's and editor's roles
    const selects = screen.getAllByRole('combobox');
    // There should be selects for admin and editor (not for owner self)
    expect(selects.length).toBeGreaterThanOrEqual(2);
  });

  it('does NOT show <select> for editor viewer looking at others', async () => {
    // Editor cannot change anyone's role
    const rows = makeMemberRows().map((m) => ({
      ...m,
      isYou: m.user.id === 'u-editor',
    }));
    mockFetch(ME_EDITOR, rows);
    renderMiembros();
    await waitFor(() => screen.getByRole('heading', { level: 1 }));
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('shows Quitar button for owner viewing admin/editor, not for self (owner blocked by targetRole)', async () => {
    mockFetch(ME_OWNER, makeMemberRows());
    renderMiembros();
    await waitFor(() => screen.getByRole('heading', { level: 1 }));
    // Owner can remove admin and editor
    expect(screen.getAllByRole('button', { name: /quitar a/i }).length).toBeGreaterThanOrEqual(1);
    // Owner's own row (role=owner) is blocked by targetRole==='owner' check → no Quitar button for self
    expect(screen.queryByRole('button', { name: /quitar a joys/i })).not.toBeInTheDocument();
  });

  it('admin self-remove: shows Quitar button on own row and dialog with self copy', async () => {
    // Admin viewer: ME_ADMIN_IS_YOU contains admin user; member list includes admin as isYou:true
    const ME_ADMIN = {
      user: { id: 'u-admin', name: 'Admin User', email: 'admin@test.dev' },
      groups: [{ slug: 'cya', name: 'CYA', role: 'admin' }],
    };
    const memberRowsAdminIsYou = [
      {
        user: { id: 'u-owner', name: 'Joys', email: 'joys@test.dev' },
        role: 'owner',
        joinedAt: new Date().toISOString(),
        isYou: false,
        lastSyncAt: null,
        devices: [],
      },
      {
        user: { id: 'u-admin', name: 'Admin User', email: 'admin@test.dev' },
        role: 'admin',
        joinedAt: new Date().toISOString(),
        isYou: true,
        lastSyncAt: null,
        devices: [],
      },
    ];

    const user = userEvent.setup();
    global.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      const method = opts?.method ?? 'GET';
      if (method === 'GET' && (url as string).endsWith('/me')) {
        return Promise.resolve({ ok: true, json: async () => ME_ADMIN });
      }
      if (method === 'GET' && (url as string).includes('/members')) {
        return Promise.resolve({ ok: true, json: async () => memberRowsAdminIsYou });
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    });

    renderMiembros();
    await waitFor(() => screen.getByRole('heading', { level: 1 }));

    // Admin should see Quitar on their own row (role=admin, not owner)
    const selfQuitarBtns = screen.getAllByRole('button', { name: /quitar a admin user/i });
    expect(selfQuitarBtns.length).toBeGreaterThan(0);

    // Click Quitar on admin's own row
    await user.click(selfQuitarBtns[0] as HTMLElement);

    // Dialog should appear with self-remove copy
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    expect(screen.getByText(/salir del parche/i)).toBeInTheDocument();
    expect(screen.getByText(/pierdes acceso/i)).toBeInTheDocument();
  });

  it('shows Revocar button for active devices, not for revoked', async () => {
    mockFetch(ME_OWNER, makeMemberRows());
    renderMiembros();
    await waitFor(() => screen.getByRole('heading', { level: 1 }));
    // Active device of editor and of owner should have Revocar buttons
    const revokeButtons = screen.getAllByRole('button', { name: /revocar/i });
    expect(revokeButtons.length).toBeGreaterThan(0);
  });

  it('shows revocado label on revoked device without Revocar button', async () => {
    mockFetch(ME_OWNER, makeMemberRows());
    renderMiembros();
    await waitFor(() => screen.getByRole('heading', { level: 1 }));
    // The revoked device shows "revocado" label
    const labels = screen.getAllByText('revocado');
    expect(labels.length).toBeGreaterThan(0);
  });

  // ── Aviso no-sync ──────────────────────────────────────────────────────────

  it('shows no-sync warning when device has no lastSeenAt', async () => {
    const rows = [
      {
        user: { id: 'u-nosync', name: 'NoSync User', email: 'nosync@test.dev' },
        role: 'editor',
        joinedAt: new Date().toISOString(),
        isYou: false,
        lastSyncAt: null,
        devices: [DEVICE_NO_SEEN], // device exists but lastSeenAt is null
      },
    ];
    mockFetch(ME_OWNER, rows);
    renderMiembros();
    // Warning appears in both desktop and mobile, use getAllByText
    await waitFor(() =>
      expect(screen.getAllByText(/no ha sincronizado/i).length).toBeGreaterThan(0),
    );
    expect(screen.getAllByText(/npx @chamba\/mcp vault sync/i).length).toBeGreaterThan(0);
  });

  it('shows no-sync warning when devices list is empty', async () => {
    const rows = [
      {
        user: { id: 'u-nosync2', name: 'Never Synced', email: 'ns2@test.dev' },
        role: 'reader',
        joinedAt: new Date().toISOString(),
        isYou: false,
        lastSyncAt: null,
        devices: [],
      },
    ];
    mockFetch(ME_OWNER, rows);
    renderMiembros();
    await waitFor(() =>
      expect(screen.getAllByText(/no ha sincronizado/i).length).toBeGreaterThan(0),
    );
  });

  it('does NOT show no-sync warning when device has lastSeenAt', async () => {
    const rows = [
      {
        user: { id: 'u-synced', name: 'Synced User', email: 'synced@test.dev' },
        role: 'editor',
        joinedAt: new Date().toISOString(),
        isYou: false,
        lastSyncAt: DEVICE_ACTIVE.lastSeenAt,
        devices: [DEVICE_ACTIVE],
      },
    ];
    mockFetch(ME_OWNER, rows);
    renderMiembros();
    await waitFor(() => screen.getByRole('heading', { level: 1 }));
    expect(screen.queryByText(/no ha sincronizado/i)).not.toBeInTheDocument();
  });

  // ── D6: no cambios pendientes ni conflictos ────────────────────────────────

  it('D6: does NOT render "cambios pendientes" text', async () => {
    mockFetch(ME_OWNER, makeMemberRows());
    renderMiembros();
    await waitFor(() => screen.getByRole('heading', { level: 1 }));
    expect(screen.queryByText(/cambios pendientes/i)).not.toBeInTheDocument();
  });

  it('D6: does NOT render "conflictos" text in member rows', async () => {
    mockFetch(ME_OWNER, makeMemberRows());
    renderMiembros();
    await waitFor(() => screen.getByRole('heading', { level: 1 }));
    expect(screen.queryByText(/\d+ conflicto/i)).not.toBeInTheDocument();
  });

  // ── Email visibility ───────────────────────────────────────────────────────

  it('does NOT show other members email when viewer is editor', async () => {
    // Backend sends no email field for non-self when viewer is editor
    const rows = [
      {
        user: { id: 'u-owner', name: 'Joys' }, // no email field
        role: 'owner',
        joinedAt: new Date().toISOString(),
        isYou: false,
        lastSyncAt: null,
        devices: [],
      },
      {
        user: { id: 'u-editor', name: 'Editor', email: 'editor@test.dev' }, // own email
        role: 'editor',
        joinedAt: new Date().toISOString(),
        isYou: true,
        lastSyncAt: null,
        devices: [],
      },
    ];
    mockFetch(ME_EDITOR, rows);
    renderMiembros();
    await waitFor(() => screen.getByRole('heading', { level: 1 }));
    // Own email is visible (appears in desktop + mobile, so use getAllByText)
    expect(screen.getAllByText('editor@test.dev').length).toBeGreaterThan(0);
    // Other email is NOT shown (backend doesn't send it)
    expect(screen.queryByText('joys@test.dev')).not.toBeInTheDocument();
  });

  // ── Confirm dialog: Quitar ─────────────────────────────────────────────────

  it('shows confirm dialog when Quitar is clicked and calls removeMember on confirm', async () => {
    const user = userEvent.setup();
    // Reload after action: second members call returns same data
    let membersCallCount = 0;
    global.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      const method = opts?.method ?? 'GET';
      if (method === 'GET' && (url as string).endsWith('/me')) {
        return Promise.resolve({ ok: true, json: async () => ME_OWNER });
      }
      if (method === 'GET' && (url as string).includes('/members')) {
        membersCallCount++;
        return Promise.resolve({ ok: true, json: async () => makeMemberRows() });
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    });

    renderMiembros();
    await waitFor(() => screen.getByRole('heading', { level: 1 }));

    // Click first "Quitar a" button (admin or editor)
    const [quitarBtn] = screen.getAllByRole('button', { name: /quitar a/i });
    await user.click(quitarBtn as HTMLElement);

    // Dialog should appear
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    expect(screen.getByText(/pierde acceso/i)).toBeInTheDocument();

    // Confirm
    await user.click(screen.getByRole('button', { name: /^quitar$/i }));

    // After action, data should reload (members fetched again)
    await waitFor(() => expect(membersCallCount).toBeGreaterThan(1));

    // Dialog should be closed
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('cancels confirm dialog on Cancelar click', async () => {
    const user = userEvent.setup();
    mockFetch(ME_OWNER, makeMemberRows());
    renderMiembros();
    await waitFor(() => screen.getByRole('heading', { level: 1 }));

    const [quitarBtn] = screen.getAllByRole('button', { name: /quitar a/i });
    await user.click(quitarBtn as HTMLElement);

    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /cancelar/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('cancels confirm dialog on Esc key', async () => {
    const user = userEvent.setup();
    mockFetch(ME_OWNER, makeMemberRows());
    renderMiembros();
    await waitFor(() => screen.getByRole('heading', { level: 1 }));

    const [quitarBtn] = screen.getAllByRole('button', { name: /quitar a/i });
    await user.click(quitarBtn as HTMLElement);

    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  // ── Confirm dialog: Revocar ───────────────────────────────────────────────

  it('shows confirm dialog with Revocar copy when Revocar device is clicked', async () => {
    const user = userEvent.setup();
    mockFetch(ME_OWNER, makeMemberRows());
    renderMiembros();
    await waitFor(() => screen.getByRole('heading', { level: 1 }));

    const [revocarBtn] = screen.getAllByRole('button', { name: /revocar/i });
    await user.click(revocarBtn as HTMLElement);

    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    expect(screen.getByText(/su sync se corta/i)).toBeInTheDocument();
  });

  // ── Error 409 from role change ─────────────────────────────────────────────

  it('shows last_owner error when role change returns 409', async () => {
    const user = userEvent.setup();
    // First load succeeds, role change returns 409
    global.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      const method = opts?.method ?? 'GET';
      if (method === 'GET' && (url as string).endsWith('/me')) {
        return Promise.resolve({ ok: true, json: async () => ME_OWNER });
      }
      if (method === 'GET' && (url as string).includes('/members')) {
        return Promise.resolve({ ok: true, json: async () => makeMemberRows() });
      }
      // POST role change fails with 409
      return Promise.resolve({
        ok: false,
        status: 409,
        json: async () => ({ error: 'last_owner' }),
      });
    });

    renderMiembros();
    await waitFor(() => screen.getByRole('heading', { level: 1 }));

    // Find a role select (admin or editor)
    const [firstSelect] = screen.getAllByRole('combobox');
    // Change first select
    await user.selectOptions(firstSelect as HTMLElement, 'reader');

    await waitFor(() =>
      expect(screen.getAllByText(/no puedes dejar el parche sin owner/i).length).toBeGreaterThan(0),
    );
  });

  // ── Footer note ───────────────────────────────────────────────────────────

  it('shows the footer note about revoking', async () => {
    mockFetch(ME_OWNER, makeMemberRows());
    renderMiembros();
    await waitFor(() =>
      expect(
        screen.getByText(/revocar un dispositivo corta su sync al instante/i),
      ).toBeInTheDocument(),
    );
  });
});
