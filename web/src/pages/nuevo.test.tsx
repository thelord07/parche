import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NuevoPage } from './nuevo.tsx';

function renderNuevo() {
  return render(
    <MemoryRouter initialEntries={['/nuevo']}>
      <Routes>
        <Route path="/nuevo" element={<NuevoPage />} />
        <Route path="/g/:slug/invitar" element={<div data-testid="invitar">Invitar</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('NuevoPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('auto-generates slug from name', async () => {
    renderNuevo();

    const nameInput = screen.getByLabelText('Nombre');
    await userEvent.type(nameInput, 'Backend Lapzo');

    const slugInput = screen.getByLabelText('Slug');
    expect(slugInput).toHaveValue('backend-lapzo');
  });

  it('marks slug as edited when manually changed', async () => {
    renderNuevo();

    const slugInput = screen.getByLabelText('Slug');
    await userEvent.clear(slugInput);
    await userEvent.type(slugInput, 'mi-slug');

    expect(screen.getByText('Editado a mano.')).toBeInTheDocument();
  });

  it('shows slug-taken error on 409', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'slug_taken' }),
    });

    renderNuevo();

    const nameInput = screen.getByLabelText('Nombre');
    await userEvent.type(nameInput, 'test');

    await userEvent.click(screen.getByRole('button', { name: /crear parche/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(/ese slug ya existe/i)).toBeInTheDocument();
    });
  });

  it('shows hint and disables submit when slug is shorter than 3 chars', async () => {
    renderNuevo();

    const slugInput = screen.getByLabelText('Slug');
    await userEvent.clear(slugInput);
    await userEvent.type(slugInput, 'ab');

    // The hint message appears
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(/entre 3 y 40/i)).toBeInTheDocument();
    });

    // Submit is disabled
    expect(screen.getByRole('button', { name: /crear parche/i })).toBeDisabled();
  });

  it('navigates to /g/:slug/invitar on success', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ groupId: '1', slug: 'backend-lapzo', name: 'Backend Lapzo' }),
    });

    renderNuevo();

    const nameInput = screen.getByLabelText('Nombre');
    await userEvent.type(nameInput, 'Backend Lapzo');

    await userEvent.click(screen.getByRole('button', { name: /crear parche/i }));

    await waitFor(() => {
      expect(screen.getByTestId('invitar')).toBeInTheDocument();
    });
  });
});
