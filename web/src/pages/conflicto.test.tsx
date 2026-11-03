import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictoPage } from './conflicto.tsx';

const ME = { user: { id: '1', name: 'Joys', email: 'joys@test.dev' }, groups: [] };

const CONFLICT_VIEW = {
  copyPath: 'auth/flujo-login (conflicto vale).md',
  originalPath: 'auth/flujo-login.md',
  base: '3e9f1c0abc1234def',
  original: {
    path: 'auth/flujo-login.md',
    hash: 'abc1234def5678901',
    hashShort: 'abc1234',
    content: '# Flujo de login\n\nversión original\n',
    author: 'joys',
    device: 'MacBook de Joys',
    at: new Date().toISOString(),
  },
  copy: {
    path: 'auth/flujo-login (conflicto vale).md',
    hash: 'def5678abc9012345',
    hashShort: 'def5678',
    content: '# Flujo de login\n\nversión de vale\n',
    author: 'vale',
    device: 'ThinkPad de Vale',
    at: new Date(Date.now() - 300000).toISOString(),
  },
  diff: [
    { kind: 'eq' as const, old: '# Flujo de login', new: '# Flujo de login' },
    { kind: 'eq' as const, old: '', new: '' },
    { kind: 'mod' as const, old: 'versión original', new: 'versión de vale' },
  ],
};

function renderConflicto() {
  return render(
    <MemoryRouter initialEntries={['/g/cya/c/auth/flujo-login (conflicto vale).md']}>
      <Routes>
        <Route path="/g/:slug/c/*" element={<ConflictoPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ConflictoPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders conflict heading', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ME })
      .mockResolvedValueOnce({ ok: true, json: async () => CONFLICT_VIEW });

    renderConflicto();
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/dos versiones/i),
    );
  });

  it('shows both author names as panel headings', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ME })
      .mockResolvedValueOnce({ ok: true, json: async () => CONFLICT_VIEW });

    renderConflicto();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /versión de joys/i })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /versión de vale/i })).toBeInTheDocument();
    });
  });

  it('does NOT have action buttons "Quedarse con esta" or "Conservar ambas" (Entrega A)', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ME })
      .mockResolvedValueOnce({ ok: true, json: async () => CONFLICT_VIEW });

    renderConflicto();
    await waitFor(() => screen.getByRole('heading', { level: 1 }));

    expect(screen.queryByRole('button', { name: /quedarse/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /quedarse/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /conservar/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /conservar/i })).not.toBeInTheDocument();
  });

  it('shows resolution message instead of action buttons', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ME })
      .mockResolvedValueOnce({ ok: true, json: async () => CONFLICT_VIEW });

    renderConflicto();
    await waitFor(() => expect(screen.getByText(/resuélvelo en tu editor/i)).toBeInTheDocument());
  });

  it('shows the diff legend', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ME })
      .mockResolvedValueOnce({ ok: true, json: async () => CONFLICT_VIEW });

    renderConflicto();
    await waitFor(() => expect(screen.getByText(/línea distinta/i)).toBeInTheDocument());
  });

  it('shows 404 state when conflict not found', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ME })
      .mockRejectedValueOnce(Object.assign(new Error('not_found'), { status: 404 }));

    renderConflicto();
    await waitFor(() => expect(screen.getByText(/conflicto no encontrado/i)).toBeInTheDocument());
  });

  // ---------------------------------------------------------------------------
  // Empty splat → immediate 404 (PARCHE-007-A fix)
  // The component must NOT call the API when copyPath is empty — it would hang
  // or silently fail. Instead it transitions to the 404 state immediately.
  // ---------------------------------------------------------------------------

  it('empty splat (copyPath="") → shows 404 state without making API calls', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    render(
      <MemoryRouter initialEntries={['/g/cya/c/']}>
        <Routes>
          <Route path="/g/:slug/c/*" element={<ConflictoPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText(/conflicto no encontrado/i)).toBeInTheDocument());

    // The API must NOT have been called since there is no copyPath to fetch
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
