import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotaPage } from './nota.tsx';

const ME = { user: { id: '1', name: 'Joys', email: 'joys@test.dev' }, groups: [] };

const NOTE_RESPONSE = {
  path: 'auth/flujo-login.md',
  title: 'Flujo de login',
  metaPending: false,
  meta: {
    title: 'Flujo de login',
    summary: null,
    type: null,
    tags: ['tema/auth'],
    workItem: 'CU-123',
    project: 'back-end-aprendizaje',
    conflictOf: null,
    conflictBase: null,
  },
  head: {
    hash: 'abc1234def5678',
    hashShort: 'abc1234',
    seq: 5,
    at: new Date().toISOString(),
    user: { name: 'Joys', email: 'joys@test.dev' },
    deviceLabel: 'mi-mac',
  },
  versions: [
    {
      seq: 5,
      hash: 'abc1234def5678',
      hashShort: 'abc1234',
      at: new Date().toISOString(),
      user: 'Joys',
      deviceLabel: 'mi-mac',
    },
    {
      seq: 3,
      hash: 'oldold1234567890',
      hashShort: 'oldold1',
      at: new Date(Date.now() - 3600000).toISOString(),
      user: 'Joys',
      deviceLabel: 'mi-mac',
    },
  ],
  backlinks: [
    {
      path: 'onboarding/setup-local.md',
      title: 'Setup local',
      snippet: '…ver [[flujo-login]] para detalles…',
    },
  ],
  html: '<p>El login usa magic link.</p>',
};

function renderNota() {
  return render(
    <MemoryRouter initialEntries={['/g/cya/n/auth/flujo-login.md']}>
      <Routes>
        <Route path="/g/:slug/n/*" element={<NotaPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('NotaPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders note title after loading', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ME })
      .mockResolvedValueOnce({ ok: true, json: async () => NOTE_RESPONSE });

    renderNota();
    await waitFor(() => {
      const h1s = screen.getAllByRole('heading', { level: 1 });
      expect(h1s.some((h) => h.textContent?.includes('Flujo de login'))).toBe(true);
    });
  });

  it('shows "Solo lectura · edita desde tu editor" label', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ME })
      .mockResolvedValueOnce({ ok: true, json: async () => NOTE_RESPONSE });

    renderNota();
    await waitFor(() => expect(screen.getByText(/solo lectura/i)).toBeInTheDocument());
  });

  it('shows metadata sidebar with author, repo, ticket', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ME })
      .mockResolvedValueOnce({ ok: true, json: async () => NOTE_RESPONSE });

    renderNota();
    await waitFor(() => {
      expect(screen.getByText('Autor')).toBeInTheDocument();
      expect(screen.getByText('Joys')).toBeInTheDocument();
      expect(screen.getByText('back-end-aprendizaje')).toBeInTheDocument();
      expect(screen.getByText('CU-123')).toBeInTheDocument();
    });
  });

  it('shows backlinks section', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ME })
      .mockResolvedValueOnce({ ok: true, json: async () => NOTE_RESPONSE });

    renderNota();
    await waitFor(() => {
      expect(screen.getByText(/enlazada desde/i)).toBeInTheDocument();
      expect(screen.getByText('onboarding/setup-local.md')).toBeInTheDocument();
      expect(screen.getByText(/ver \[\[flujo-login\]\]/i)).toBeInTheDocument();
    });
  });

  it('shows history with version buttons (Ver / Diff) but NO Restaurar', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ME })
      .mockResolvedValueOnce({ ok: true, json: async () => NOTE_RESPONSE });

    renderNota();
    await waitFor(() => screen.getByText(/historial/i));

    // Should have Ver / Diff buttons for non-head version
    expect(screen.getAllByRole('button', { name: /ver/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('button', { name: /diff/i }).length).toBeGreaterThanOrEqual(1);

    // Should NOT have Restaurar (Entrega C)
    expect(screen.queryByRole('button', { name: /restaurar/i })).not.toBeInTheDocument();
  });

  it('shows metaPending state when metaPending is true', async () => {
    const pendingNote = { ...NOTE_RESPONSE, metaPending: true, html: '' };
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ME })
      .mockResolvedValueOnce({ ok: true, json: async () => pendingNote });

    renderNota();
    await waitFor(() => expect(screen.getAllByText(/procesando/i).length).toBeGreaterThan(0));
  });

  it('shows 404 when note not found', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ME })
      .mockRejectedValueOnce(Object.assign(new Error('not_found'), { status: 404 }));

    renderNota();
    await waitFor(() => expect(screen.getByText(/nota no encontrada/i)).toBeInTheDocument());
  });

  it('does not show "Restaurar" button (Entrega C only)', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ME })
      .mockResolvedValueOnce({ ok: true, json: async () => NOTE_RESPONSE });

    renderNota();
    await waitFor(() => screen.getByRole('heading', { level: 1 }));
    expect(screen.queryByRole('button', { name: /restaurar/i })).not.toBeInTheDocument();
  });
});
