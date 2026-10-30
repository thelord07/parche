import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnisrsePage } from './unirse.tsx';

function renderUnirse(codigo: string) {
  return render(
    <MemoryRouter initialEntries={[`/j/${codigo}`]}>
      <Routes>
        <Route path="/j/:codigo" element={<UnisrsePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('UnisrsePage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the join command when invite is valid', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        valid: true,
        group: { name: 'Backend Lapzo', slug: 'backend-lapzo' },
        role: 'editor',
        inviter: 'joys',
        expiresLabel: 'en 7 días',
      }),
    });

    renderUnirse('K7QX-M2RP');

    await waitFor(() => {
      expect(screen.getByText(/vault join K7QX-M2RP/)).toBeInTheDocument();
    });
  });

  it('shows "Esta invitación ya no sirve" with neutral badge for invalid code', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ valid: false }),
    });

    renderUnirse('XXXX-YYYY');

    await waitFor(() => {
      expect(screen.getByText('Esta invitación ya no sirve')).toBeInTheDocument();
      // Badge must be neutral — never imply a specific reason (AC9)
      expect(screen.getByText('Invitación no válida')).toBeInTheDocument();
      expect(screen.queryByText('Invitación vencida')).not.toBeInTheDocument();
    });
  });
});
