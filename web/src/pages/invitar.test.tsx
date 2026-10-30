import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InvitarPage } from './invitar.tsx';

const MOCK_INVITES = [
  {
    id: 'inv1',
    codeDisplay: 'K7QX-••••',
    role: 'editor',
    expiresAt: null,
    maxUses: 10,
    uses: 0,
    createdBy: 'joys',
    createdAt: new Date().toISOString(),
  },
];

function renderInvitar() {
  return render(
    <MemoryRouter initialEntries={['/g/backend-lapzo/invitar']}>
      <Routes>
        <Route path="/g/:slug/invitar" element={<InvitarPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('InvitarPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the invite code once after creating', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [] }) // initial load
      .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 'K7QX-M2RP' }) }) // create
      .mockResolvedValueOnce({ ok: true, json: async () => MOCK_INVITES }); // reload

    renderInvitar();

    await userEvent.click(screen.getByRole('button', { name: /generar código/i }));

    await waitFor(() => {
      // The full code is shown exactly once (the big code display), right after creation
      expect(screen.getAllByText('K7QX-M2RP')).toHaveLength(1);
    });
  });

  it('shows the full link URL matching the copied text', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 'K7QX-M2RP' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => MOCK_INVITES });

    renderInvitar();
    await userEvent.click(screen.getByRole('button', { name: /generar código/i }));

    await waitFor(() => {
      // The displayed link should contain the full origin (jsdom uses http://localhost)
      const displayed = screen.getByText(/\/j\/K7QX-M2RP/);
      expect(displayed).toBeInTheDocument();
      // The copy button copies the same text shown
      expect(displayed.textContent).toBe(`${window.location.origin}/j/K7QX-M2RP`);
    });
  });

  it('shows masked codes in the list', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => MOCK_INVITES });

    renderInvitar();

    await waitFor(() => {
      // Rendered once in the desktop table and once in the mobile list (CSS hides one)
      expect(screen.getAllByText('K7QX-••••')).toHaveLength(2);
    });
  });

  it('removes invite from list after revoke', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => MOCK_INVITES })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

    renderInvitar();

    await waitFor(() => {
      expect(screen.getAllByText('K7QX-••••')).toHaveLength(2);
    });

    const revokeBtn = screen.getAllByRole('button', { name: /revocar invitación/i })[0];
    await userEvent.click(revokeBtn);

    await waitFor(() => {
      expect(screen.queryByText('K7QX-••••')).not.toBeInTheDocument();
      // Both desktop and mobile show the empty state
      expect(screen.getAllByText('No hay invitaciones activas.')).toHaveLength(2);
    });
  });

  it('shows an error message when create returns 403', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [] }) // initial load
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({ error: 'forbidden' }),
      }); // create fails

    renderInvitar();

    await userEvent.click(screen.getByRole('button', { name: /generar código/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(/no tienes permiso/i)).toBeInTheDocument();
    });
  });
});
