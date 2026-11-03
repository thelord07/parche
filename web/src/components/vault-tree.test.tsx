import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VaultTree } from './vault-tree.tsx';

const ROOT_TREE = {
  path: '',
  items: [
    { name: 'auth', type: 'dir', count: 2 },
    { name: 'db', type: 'dir', count: 3 },
    { name: 'README.md', type: 'file', title: 'README' },
  ],
};

const AUTH_TREE = {
  path: 'auth',
  items: [
    { name: 'flujo-login.md', type: 'file', title: 'Flujo de login' },
    { name: 'tokens-refresh.md', type: 'file', title: 'Tokens Refresh' },
  ],
};

function renderTree() {
  return render(
    <MemoryRouter>
      <VaultTree slug="cya" />
    </MemoryRouter>,
  );
}

describe('VaultTree', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders root items after loading', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ROOT_TREE });

    renderTree();
    await waitFor(() => expect(screen.getByText('README')).toBeInTheDocument());
    expect(screen.getByText(/auth\//)).toBeInTheDocument();
    expect(screen.getByText(/db\//)).toBeInTheDocument();
  });

  it('expands folder on click and loads children', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ROOT_TREE })
      .mockResolvedValueOnce({ ok: true, json: async () => AUTH_TREE });

    renderTree();

    await waitFor(() => screen.getByText(/auth\//));
    await userEvent.click(screen.getByText(/auth\//));

    await waitFor(() => expect(screen.getByText('Flujo de login')).toBeInTheDocument());
    expect(screen.getByText('Tokens Refresh')).toBeInTheDocument();
  });

  it('folder has aria-expanded=false initially', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ROOT_TREE });

    renderTree();

    await waitFor(() => screen.getByText(/auth\//));

    const folderEl = screen.getByRole('treeitem', { name: /auth\//i });
    expect(folderEl).toHaveAttribute('aria-expanded', 'false');
  });

  it('folder has aria-expanded=true after expand', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ROOT_TREE })
      .mockResolvedValueOnce({ ok: true, json: async () => AUTH_TREE });

    renderTree();

    await waitFor(() => screen.getByText(/auth\//));
    await userEvent.click(screen.getByText(/auth\//));

    await waitFor(() => {
      const folderEl = screen.getByRole('treeitem', { name: /auth\//i });
      expect(folderEl).toHaveAttribute('aria-expanded', 'true');
    });
  });

  it('navigates with ArrowDown key', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ROOT_TREE });

    renderTree();
    await waitFor(() => screen.getByText(/auth\//));

    const authFolder = screen.getByRole('treeitem', { name: /auth\//i });
    authFolder.focus();

    await userEvent.keyboard('{ArrowDown}');

    // db/ should be focused
    const dbFolder = screen.getByRole('treeitem', { name: /db\//i });
    expect(document.activeElement).toBe(dbFolder);
  });

  it('Enter expands a folder', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ROOT_TREE })
      .mockResolvedValueOnce({ ok: true, json: async () => AUTH_TREE });

    renderTree();
    await waitFor(() => screen.getByText(/auth\//));

    const authFolder = screen.getByRole('treeitem', { name: /auth\//i });
    authFolder.focus();
    await userEvent.keyboard('{Enter}');

    await waitFor(() => expect(screen.getByText('Flujo de login')).toBeInTheDocument());
  });

  it('Home moves focus to the first visible item', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ROOT_TREE });

    renderTree();
    await waitFor(() => screen.getByText(/auth\//));

    // Focus the last item (README.md), then press Home
    const readmeLink = screen.getByRole('treeitem', { name: /README/i });
    readmeLink.focus();

    await userEvent.keyboard('{Home}');

    // First item is auth/
    const authFolder = screen.getByRole('treeitem', { name: /auth\//i });
    expect(document.activeElement).toBe(authFolder);
  });

  it('End moves focus to the last visible item', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ROOT_TREE });

    renderTree();
    await waitFor(() => screen.getByText(/auth\//));

    // Focus the first item (auth/), then press End
    const authFolder = screen.getByRole('treeitem', { name: /auth\//i });
    authFolder.focus();

    await userEvent.keyboard('{End}');

    // Last item is README.md
    const readmeLink = screen.getByRole('treeitem', { name: /README/i });
    expect(document.activeElement).toBe(readmeLink);
  });
});
