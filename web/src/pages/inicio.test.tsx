import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InicioPage } from './inicio.tsx';

const ME_WITH_GROUPS = {
  user: { id: '1', name: 'Joys', email: 'joys@test.dev' },
  groups: [
    { slug: 'backend-lapzo', name: 'backend-lapzo', role: 'owner' },
    { slug: 'frontend-lms', name: 'frontend-lms', role: 'editor' },
  ],
};

function renderInicio() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <InicioPage />
    </MemoryRouter>,
  );
}

describe('InicioPage — dashboard links', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('each group card links to /g/:slug (dashboard)', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ME_WITH_GROUPS });

    renderInicio();

    await waitFor(() => {
      const verLinks = screen.getAllByRole('link', { name: /ver →/i });
      expect(verLinks).toHaveLength(2);
      expect(verLinks[0]).toHaveAttribute('href', '/g/backend-lapzo');
      expect(verLinks[1]).toHaveAttribute('href', '/g/frontend-lms');
    });
  });

  it('owner/admin group cards also show the Invitar link', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ME_WITH_GROUPS });

    renderInicio();

    await waitFor(() => {
      // backend-lapzo is owner → shows Invitar
      const inviteLinks = screen.getAllByRole('link', { name: /invitar →/i });
      expect(inviteLinks).toHaveLength(1);
      expect(inviteLinks[0]).toHaveAttribute('href', '/g/backend-lapzo/invitar');
    });
  });

  it('editor group card does not show Invitar', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ME_WITH_GROUPS });

    renderInicio();

    await waitFor(() => screen.getAllByRole('link', { name: /ver →/i }));

    // frontend-lms is editor — no Invitar link for it
    const allLinks = screen.getAllByRole('link');
    const frontendInvite = allLinks.find(
      (l) => l.getAttribute('href') === '/g/frontend-lms/invitar',
    );
    expect(frontendInvite).toBeUndefined();
  });
});
