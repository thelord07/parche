import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardPage } from './dashboard.tsx';

const ME = { user: { id: '1', name: 'Joys', email: 'joys@test.dev' }, groups: [] };

const SUMMARY = {
  group: { slug: 'cya', name: 'CYA', role: 'owner' },
  notes: 5,
  folders: 2,
  conflicts: 0,
  lastChangeAt: new Date().toISOString(),
  members: [{ name: 'Joys', email: 'joys@test.dev', role: 'owner' }],
};

const ACTIVITY = { events: [], hasMore: false, nextBefore: null };
const TOPICS = { nodes: [] };
const TREE = { path: '', items: [] };
const EMPTY_SECRETS = {
  open: { count: 0, items: [], hasMore: false, total: 0 },
  pendingRotation: { count: 0, items: [], hasMore: false, total: 0 },
};

function renderDashboard() {
  return render(
    <MemoryRouter initialEntries={['/g/cya']}>
      <Routes>
        <Route path="/g/:slug" element={<DashboardPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetch(overrides: { summary?: unknown; activity?: unknown } = {}) {
    const summary = overrides.summary ?? SUMMARY;
    const activity = overrides.activity ?? ACTIVITY;
    global.fetch = vi.fn().mockImplementation((url: string) => {
      let response: unknown = TREE;
      if (url.includes('/me')) response = ME;
      else if (url.includes('/summary')) response = summary;
      else if (url.includes('/activity')) response = activity;
      else if (url.includes('/topics')) response = TOPICS;
      else if (url.includes('/secrets')) response = EMPTY_SECRETS;
      else if (url.includes('/tree')) response = TREE;
      return Promise.resolve({ ok: true, json: async () => response });
    });
  }

  it('renders group name after loading', async () => {
    mockFetch();
    renderDashboard();
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('CYA'));
  });

  it('renders Miembros link pointing to /g/:slug/miembros (B-FE5)', async () => {
    mockFetch();
    renderDashboard();
    await waitFor(() => screen.getByRole('heading', { level: 1 }));
    // The Miembros link is visible for all roles (read access)
    const miembrosLink = screen.getByRole('link', { name: /miembros/i });
    expect(miembrosLink).toBeInTheDocument();
    expect(miembrosLink).toHaveAttribute('href', '/g/cya/miembros');
  });

  it('shows conflict pill when conflicts > 0', async () => {
    const summaryWithConflict = { ...SUMMARY, conflicts: 2 };
    mockFetch({ summary: summaryWithConflict });
    renderDashboard();
    // Both hero badge and main banner show "conflictos" — use getAllByText
    await waitFor(() => expect(screen.getAllByText(/2 conflictos/i).length).toBeGreaterThan(0));
  });

  it('does NOT show conflict pill when conflicts === 0', async () => {
    mockFetch();
    renderDashboard();
    await waitFor(() => screen.getByRole('heading', { level: 1 }));
    expect(screen.queryByText(/conflicto/i)).not.toBeInTheDocument();
  });

  it('shows empty activity when no events', async () => {
    mockFetch();
    renderDashboard();
    await waitFor(() => expect(screen.getByText(/sin actividad/i)).toBeInTheDocument());
  });

  it('shows "Ver más" button when hasMore is true and loads more on click', async () => {
    const event1 = {
      seq: 2,
      path: 'auth/flujo.md',
      verb: 'guardó',
      hash: 'abc1234',
      hashCorto: 'abc1234',
      user: { name: 'Joys', email: 'joys@test.dev' },
      deviceLabel: 'mi-mac',
      at: new Date().toISOString(),
    };
    const event2 = {
      seq: 1,
      path: 'db/schema.md',
      verb: 'creó',
      hash: 'def5678',
      hashCorto: 'def5678',
      user: { name: 'Joys', email: 'joys@test.dev' },
      deviceLabel: 'mi-mac',
      at: new Date(Date.now() - 86400000).toISOString(),
    };

    const activityPage1 = { events: [event1], hasMore: true, nextBefore: 2 };
    const activityPage2 = { events: [event2], hasMore: false, nextBefore: null };

    // URL-based routing so call order doesn't matter
    let activityCallCount = 0;
    global.fetch = vi.fn().mockImplementation((url: string) => {
      let response: unknown = TREE;
      if (url.includes('/me')) response = ME;
      else if (url.includes('/summary')) response = SUMMARY;
      else if (url.includes('/activity')) {
        response = activityCallCount === 0 ? activityPage1 : activityPage2;
        activityCallCount++;
      } else if (url.includes('/topics')) response = TOPICS;
      else if (url.includes('/secrets')) response = EMPTY_SECRETS;
      else if (url.includes('/tree')) response = TREE;
      return Promise.resolve({ ok: true, json: async () => response });
    });

    renderDashboard();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /ver más/i })).toBeInTheDocument(),
    );

    await userEvent.click(screen.getByRole('button', { name: /ver más/i }));

    // The path appears as code in the activity row
    await waitFor(() => expect(screen.getByText('db/schema.md')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /ver más/i })).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // PARCHE-012 — secrets banner
  // ---------------------------------------------------------------------------

  const TWO_FINDINGS_SECRETS = {
    open: {
      count: 1,
      items: [
        {
          id: 1,
          path: 'security/credenciales-viejas.md',
          kind: 'aws-access-key',
          since: new Date().toISOString(),
        },
        {
          id: 2,
          path: 'security/credenciales-viejas.md',
          kind: 'parche-token',
          since: new Date().toISOString(),
        },
      ],
      hasMore: false,
      total: 2,
    },
    pendingRotation: { count: 0, items: [], hasMore: false, total: 0 },
  };

  function mockFetchWithSecrets(role: string, secrets: unknown) {
    const getSecretsSpy = vi.fn().mockImplementation((url: string) => {
      let response: unknown = TREE;
      if (url.includes('/me')) response = ME;
      else if (url.includes('/summary'))
        response = { ...SUMMARY, group: { ...SUMMARY.group, role } };
      else if (url.includes('/activity')) response = ACTIVITY;
      else if (url.includes('/topics')) response = TOPICS;
      else if (url.includes('/secrets')) {
        response = secrets;
      } else if (url.includes('/tree')) response = TREE;
      return Promise.resolve({ ok: true, json: async () => response });
    });
    global.fetch = getSecretsSpy;
    return getSecretsSpy;
  }

  it('owner with 2 findings on 1 note → shows "1 nota con posibles secretos" and 2 rows', async () => {
    mockFetchWithSecrets('owner', TWO_FINDINGS_SECRETS);
    renderDashboard();
    await waitFor(() =>
      expect(screen.getByText(/1 nota con posibles secretos/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/aws-access-key/)).toBeInTheDocument();
    expect(screen.getByText(/parche-token/)).toBeInTheDocument();
    expect(screen.getByText(/rota la credencial/i)).toBeInTheDocument();
  });

  it('admin → the banner appears too', async () => {
    mockFetchWithSecrets('admin', TWO_FINDINGS_SECRETS);
    renderDashboard();
    await waitFor(() =>
      expect(screen.getByText(/1 nota con posibles secretos/i)).toBeInTheDocument(),
    );
  });

  it('editor → no banner, and /secrets is never fetched', async () => {
    const spy = mockFetchWithSecrets('editor', TWO_FINDINGS_SECRETS);
    renderDashboard();
    await waitFor(() => screen.getByRole('heading', { level: 1 }));
    expect(screen.queryByText(/posibles secretos/i)).not.toBeInTheDocument();
    const calledSecrets = spy.mock.calls.some((c) => String(c[0]).includes('/secrets'));
    expect(calledSecrets).toBe(false);
  });

  it('reader → no banner, and /secrets is never fetched', async () => {
    const spy = mockFetchWithSecrets('reader', TWO_FINDINGS_SECRETS);
    renderDashboard();
    await waitFor(() => screen.getByRole('heading', { level: 1 }));
    expect(screen.queryByText(/posibles secretos/i)).not.toBeInTheDocument();
    const calledSecrets = spy.mock.calls.some((c) => String(c[0]).includes('/secrets'));
    expect(calledSecrets).toBe(false);
  });

  it('the rendered DOM never contains a fingerprint-looking value', async () => {
    mockFetchWithSecrets('owner', TWO_FINDINGS_SECRETS);
    const { container } = renderDashboard();
    await waitFor(() =>
      expect(screen.getByText(/1 nota con posibles secretos/i)).toBeInTheDocument(),
    );
    expect(container.innerHTML).not.toMatch(/\bfingerprint\b/i);
    expect(container.innerHTML).not.toMatch(/"line":/);
  });

  it('pendingRotation block shows "Pendiente rotar credencial" when there are resolved-but-unacked findings', async () => {
    const secrets = {
      open: { count: 0, items: [], hasMore: false, total: 0 },
      pendingRotation: {
        count: 1,
        items: [
          { id: 3, path: 'rotated.md', kind: 'aws-access-key', since: new Date().toISOString() },
        ],
        hasMore: false,
        total: 1,
      },
    };
    mockFetchWithSecrets('owner', secrets);
    renderDashboard();
    await waitFor(() =>
      expect(screen.getByText(/pendiente rotar credencial/i)).toBeInTheDocument(),
    );
  });

  it('shows "y N más…" with the exact remaining count when a list is truncated', async () => {
    const secrets = {
      open: {
        count: 1,
        items: [
          { id: 1, path: 'leak.md', kind: 'aws-access-key', since: new Date().toISOString() },
        ],
        hasMore: true,
        total: 5,
      },
      pendingRotation: { count: 0, items: [], hasMore: false, total: 0 },
    };
    mockFetchWithSecrets('owner', secrets);
    renderDashboard();
    // total (5) - items shown (1) = 4 hidden.
    await waitFor(() => expect(screen.getByText(/y 4 más…/i)).toBeInTheDocument());
  });

  it('ack on an OPEN finding: POSTs ack, keeps the item visible in `open`, and refetches /secrets', async () => {
    const secretsBeforeAck = {
      open: {
        count: 1,
        items: [
          { id: 42, path: 'leak.md', kind: 'aws-access-key', since: new Date().toISOString() },
        ],
        hasMore: false,
        total: 1,
      },
      pendingRotation: { count: 0, items: [], hasMore: false, total: 0 },
    };
    // After ack, the server still reports it as open (resolved_at IS NULL — acking
    // an open finding never resolves it) — only counts/total might change elsewhere.
    const secretsAfterAck = secretsBeforeAck;

    let ackCalled = false;
    let getSecretsCallCount = 0;
    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/secrets/42/ack')) {
        ackCalled = true;
        expect(init?.method).toBe('POST');
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      let response: unknown = TREE;
      if (url.includes('/me')) response = ME;
      else if (url.includes('/summary')) response = SUMMARY;
      else if (url.includes('/activity')) response = ACTIVITY;
      else if (url.includes('/topics')) response = TOPICS;
      else if (url.includes('/secrets')) {
        getSecretsCallCount++;
        response = getSecretsCallCount <= 1 ? secretsBeforeAck : secretsAfterAck;
      } else if (url.includes('/tree')) response = TREE;
      return Promise.resolve({ ok: true, json: async () => response });
    });

    renderDashboard();
    await waitFor(() => expect(screen.getByText('leak.md')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /ya roté la credencial/i }));

    await waitFor(() => expect(ackCalled).toBe(true));
    // Refetch: /secrets is called again after the ack (initial load + refetch).
    await waitFor(() => expect(getSecretsCallCount).toBeGreaterThanOrEqual(2));
    // Still visible in `open` — an open finding is still a live secret.
    expect(screen.getByText('leak.md')).toBeInTheDocument();
  });

  it('ack on a PENDING-ROTATION finding removes it from view', async () => {
    const secretsBeforeAck = {
      open: { count: 0, items: [], hasMore: false, total: 0 },
      pendingRotation: {
        count: 1,
        items: [
          { id: 7, path: 'rotated.md', kind: 'aws-access-key', since: new Date().toISOString() },
        ],
        hasMore: false,
        total: 1,
      },
    };
    // After the ack, the server's pendingRotation query (isNull(acknowledgedAt)) no
    // longer matches this row — the refetch reflects that.
    const secretsAfterAck = {
      open: { count: 0, items: [], hasMore: false, total: 0 },
      pendingRotation: { count: 0, items: [], hasMore: false, total: 0 },
    };

    let ackCalled = false;
    let getSecretsCallCount = 0;
    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/secrets/7/ack')) {
        ackCalled = true;
        expect(init?.method).toBe('POST');
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      let response: unknown = TREE;
      if (url.includes('/me')) response = ME;
      else if (url.includes('/summary')) response = SUMMARY;
      else if (url.includes('/activity')) response = ACTIVITY;
      else if (url.includes('/topics')) response = TOPICS;
      else if (url.includes('/secrets')) {
        getSecretsCallCount++;
        response = getSecretsCallCount <= 1 ? secretsBeforeAck : secretsAfterAck;
      } else if (url.includes('/tree')) response = TREE;
      return Promise.resolve({ ok: true, json: async () => response });
    });

    renderDashboard();
    await waitFor(() => expect(screen.getByText('rotated.md')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /ya roté la credencial/i }));

    await waitFor(() => expect(ackCalled).toBe(true));
    await waitFor(() => expect(screen.queryByText('rotated.md')).not.toBeInTheDocument());
  });

  it('shows 404 state when fetch returns 404', async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('not_found'), { status: 404 }));

    renderDashboard();
    await waitFor(() => expect(screen.getByText(/parche no encontrado/i)).toBeInTheDocument());
  });

  it('redirects to /entrar on 401', async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('unauthorized'), { status: 401 }));

    const { container } = renderDashboard();
    // After redirect, nothing should be in container (MemoryRouter navigates but no /entrar route)
    await waitFor(() => {
      expect(container.querySelector('h1')).not.toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Conflict pill / banner link behavior (PARCHE-007-A fix)
  // ---------------------------------------------------------------------------

  it('1 conflict → hero pill links to /g/:slug/c/<encoded copyPath>', async () => {
    const copyPath = 'notes/my note (conflicto vale).md';
    const summaryWithConflict = { ...SUMMARY, conflicts: 1 };
    const conflictRows = [
      {
        copyPath,
        originalPath: 'notes/my note.md',
        base: 'abc123',
        autorCopia: 'vale',
        at: new Date().toISOString(),
      },
    ];

    global.fetch = vi.fn().mockImplementation((url: string) => {
      let response: unknown = TREE;
      if (url.includes('/me')) response = ME;
      else if (url.includes('/summary')) response = summaryWithConflict;
      else if (url.includes('/activity')) response = ACTIVITY;
      else if (url.includes('/topics')) response = TOPICS;
      else if (url.includes('/secrets')) response = EMPTY_SECRETS;
      else if (url.includes('/tree')) response = TREE;
      else if (url.includes('/conflicts')) response = conflictRows;
      return Promise.resolve({ ok: true, json: async () => response });
    });

    renderDashboard();
    await waitFor(() => screen.getByRole('heading', { level: 1 }));

    // Wait for conflict rows to load (fetched after summary)
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('link')
          .some((l) => l.getAttribute('href')?.includes(encodeURIComponent(copyPath))),
      ).toBe(true),
    );

    const expectedHref = `/g/cya/c/${encodeURIComponent(copyPath)}`;
    const links = screen.getAllByRole('link');
    const conflictLink = links.find((l) => l.getAttribute('href') === expectedHref);
    expect(conflictLink).toBeTruthy();
  });

  it('multiple conflicts → banner shows a link per conflict (not a single direct link)', async () => {
    const copyPaths = ['notes/file-a (conflicto vale).md', 'notes/file-b (conflicto joys).md'];
    const summaryWithConflicts = { ...SUMMARY, conflicts: 2 };
    const conflictRows = copyPaths.map((cp, i) => ({
      copyPath: cp,
      originalPath: `notes/file-${String.fromCharCode(97 + i)}.md`,
      base: `base${i}`,
      autorCopia: i === 0 ? 'vale' : 'joys',
      at: new Date().toISOString(),
    }));

    global.fetch = vi.fn().mockImplementation((url: string) => {
      let response: unknown = TREE;
      if (url.includes('/me')) response = ME;
      else if (url.includes('/summary')) response = summaryWithConflicts;
      else if (url.includes('/activity')) response = ACTIVITY;
      else if (url.includes('/topics')) response = TOPICS;
      else if (url.includes('/secrets')) response = EMPTY_SECRETS;
      else if (url.includes('/tree')) response = TREE;
      else if (url.includes('/conflicts')) response = conflictRows;
      return Promise.resolve({ ok: true, json: async () => response });
    });

    renderDashboard();
    await waitFor(() => screen.getByRole('heading', { level: 1 }));

    // Wait for the conflict list to appear (triggered by summary.conflicts > 1 + conflictRows loaded)
    await waitFor(() => expect(screen.getByText(/ver todos/i)).toBeInTheDocument());

    // Each copyPath must appear as a link with the correct encoded href
    for (const cp of copyPaths) {
      const expectedHref = `/g/cya/c/${encodeURIComponent(cp)}`;
      const link = screen.getAllByRole('link').find((l) => l.getAttribute('href') === expectedHref);
      expect(link).toBeTruthy();
    }
  });

  it('0 conflicts → no conflict pill or banner', async () => {
    mockFetch(); // SUMMARY has conflicts: 0
    renderDashboard();
    await waitFor(() => screen.getByRole('heading', { level: 1 }));
    // No element containing "conflicto" or "conflictos" should be present
    expect(screen.queryByText(/conflicto/i)).not.toBeInTheDocument();
  });
});
