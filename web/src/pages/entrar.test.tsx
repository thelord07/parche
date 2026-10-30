import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EntrarPage } from './entrar.tsx';

describe('EntrarPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows "Revisa tu correo" after successful submit', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });

    render(
      <MemoryRouter>
        <EntrarPage />
      </MemoryRouter>,
    );

    const input = screen.getByLabelText('Correo');
    await userEvent.type(input, 'user@test.com');
    await userEvent.click(screen.getByRole('button', { name: /enviar link/i }));

    await waitFor(() => {
      expect(screen.getByText('Revisa tu correo')).toBeInTheDocument();
    });
  });

  it('shows error message when fetch fails', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'internal' }),
    });

    render(
      <MemoryRouter>
        <EntrarPage />
      </MemoryRouter>,
    );

    const input = screen.getByLabelText('Correo');
    await userEvent.type(input, 'user@test.com');
    await userEvent.click(screen.getByRole('button', { name: /enviar link/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });
});
