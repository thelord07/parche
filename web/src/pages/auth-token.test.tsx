import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthTokenPage } from './auth-token.tsx';

/**
 * B1(c,d) — SPA tests for hash-based token.
 *
 * The component mounts at /auth, reads window.location.hash for the token,
 * immediately calls history.replaceState to clear the hash, makes NO fetch on
 * mount, and POSTs the token on button click.
 *
 * If the hash is empty or absent, the invalid state is shown.
 */

function renderAtAuth(hash: string) {
  // jsdom does not expose location.hash via MemoryRouter, so we set it directly.
  // MemoryRouter is still used for navigate() to work.
  Object.defineProperty(window, 'location', {
    value: {
      ...window.location,
      hash,
      href: `http://localhost/auth${hash}`,
    },
    writable: true,
    configurable: true,
  });

  return render(
    <MemoryRouter initialEntries={['/auth']}>
      <Routes>
        <Route path="/auth" element={<AuthTokenPage />} />
        <Route path="/" element={<div data-testid="home">Home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AuthTokenPage (B1 — hash-based token)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(history, 'replaceState');
  });

  // B1(c): /auth#abc — reads token, clears hash, no fetch on mount, click POSTs
  it('does NOT make a fetch request on mount when hash is present', () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    renderAtAuth('#abc');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls history.replaceState to clear the hash from the address bar', () => {
    global.fetch = vi.fn();
    renderAtAuth('#mytoken');

    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/auth');
  });

  it('shows the "Entrar" button when hash token is present', () => {
    global.fetch = vi.fn();
    renderAtAuth('#abc123');
    expect(screen.getByRole('button', { name: /entrar/i })).toBeInTheDocument();
  });

  it('POSTs {token} from hash on button click and navigates to /', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });

    renderAtAuth('#my-token');

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

    renderAtAuth('#bad-token');

    await userEvent.click(screen.getByRole('button', { name: /entrar/i }));

    await waitFor(() => {
      expect(screen.getByText(/link usado o vencido/i)).toBeInTheDocument();
    });
  });

  // B1(d): empty hash shows the invalid state with link back to /entrar
  it('shows "link usado o vencido" and link to /entrar when hash is empty', () => {
    global.fetch = vi.fn();
    renderAtAuth('');

    expect(screen.getByText(/link usado o vencido/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /volver a entrar/i })).toBeInTheDocument();
  });

  it('shows "link usado o vencido" and link to /entrar when no hash at all', () => {
    // Simulate no hash (hash is '')
    Object.defineProperty(window, 'location', {
      value: { ...window.location, hash: '', href: 'http://localhost/auth' },
      writable: true,
      configurable: true,
    });
    global.fetch = vi.fn();

    render(
      <MemoryRouter initialEntries={['/auth']}>
        <Routes>
          <Route path="/auth" element={<AuthTokenPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText(/link usado o vencido/i)).toBeInTheDocument();
  });

  it('under StrictMode (double effects in dev) still shows Entrar and POSTs the token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    global.fetch = fetchMock;
    Object.defineProperty(window, 'location', {
      value: { ...window.location, hash: '#abc', href: 'http://localhost/auth#abc' },
      writable: true,
      configurable: true,
    });
    // Make replaceState really clear the hash, as a browser does, so a second
    // effect run would see an empty fragment.
    vi.spyOn(history, 'replaceState').mockImplementation(() => {
      window.location.hash = '';
    });

    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/auth']}>
          <Routes>
            <Route path="/auth" element={<AuthTokenPage />} />
            <Route path="/" element={<div data-testid="home">Home</div>} />
          </Routes>
        </MemoryRouter>
      </StrictMode>,
    );

    await userEvent.click(screen.getByRole('button', { name: /entrar/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({ token: 'abc' });
  });
});
