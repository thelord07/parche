import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthTokenPage } from './auth-token.tsx';

function renderWithToken(token: string) {
  return render(
    <MemoryRouter initialEntries={[`/auth/${token}`]}>
      <Routes>
        <Route path="/auth/:token" element={<AuthTokenPage />} />
        <Route path="/" element={<div data-testid="home">Home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AuthTokenPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('does NOT make a fetch request on mount', () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    renderWithToken('abc123');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the "Entrar" button', () => {
    global.fetch = vi.fn();
    renderWithToken('abc123');
    expect(screen.getByRole('button', { name: /entrar/i })).toBeInTheDocument();
  });

  it('POSTs to verify on button click and navigates to /', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });

    renderWithToken('my-token');

    await userEvent.click(screen.getByRole('button', { name: /entrar/i }));

    await waitFor(() => {
      expect(screen.getByTestId('home')).toBeInTheDocument();
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/web/auth/verify',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ token: 'my-token' }),
      }),
    );
  });

  it('shows "link usado o vencido" error state on 410', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 410,
      json: async () => ({ error: 'link' }),
    });

    renderWithToken('bad-token');

    await userEvent.click(screen.getByRole('button', { name: /entrar/i }));

    await waitFor(() => {
      expect(screen.getByText(/link usado o vencido/i)).toBeInTheDocument();
    });
  });
});
