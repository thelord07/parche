import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffEntry, NoteVersion } from '../api.ts';
import { HistoryList } from './history-list.tsx';

const VERSIONS: NoteVersion[] = [
  {
    seq: 3,
    hash: 'aabbccdd',
    hashShort: 'aabbccd',
    at: '2024-01-03T10:00:00Z',
    user: 'alice',
    deviceLabel: 'laptop',
  },
  {
    seq: 2,
    hash: 'bbccddee',
    hashShort: 'bbccdde',
    at: '2024-01-02T10:00:00Z',
    user: 'bob',
    deviceLabel: 'desktop',
  },
  {
    seq: 1,
    hash: 'ccddeeff',
    hashShort: 'ccddEff',
    at: '2024-01-01T10:00:00Z',
    user: 'alice',
    deviceLabel: 'laptop',
  },
];

const DIFF_RESULT: DiffEntry[] = [
  { kind: 'eq', old: 'línea igual', new: 'línea igual' },
  { kind: 'add', new: 'línea nueva' },
  { kind: 'del', old: 'línea borrada' },
];

function renderHistory() {
  return render(<HistoryList slug="grp" path="nota.md" versions={VERSIONS} headSeq={3} />);
}

describe('HistoryList', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders all versions', () => {
    renderHistory();
    // seq 3 is head — no buttons; seq 2 and 1 have buttons
    expect(screen.getAllByRole('button', { name: /Ver versión/i })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /Diff/i })).toHaveLength(2);
  });

  // ── aria-expanded ────────────────────────────────────────────────────────────

  it('Ver versión button has aria-expanded=false initially', () => {
    renderHistory();
    const buttons = screen.getAllByRole('button', { name: /Ver versión/i });
    for (const btn of buttons) {
      expect(btn).toHaveAttribute('aria-expanded', 'false');
    }
  });

  it('Diff button has aria-expanded=false initially', () => {
    renderHistory();
    const buttons = screen.getAllByRole('button', { name: /Diff/i });
    for (const btn of buttons) {
      expect(btn).toHaveAttribute('aria-expanded', 'false');
    }
  });

  it('Ver versión button sets aria-expanded=true when panel opens', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ path: 'nota.md', seq: 2, hash: 'bbccddee', content: 'contenido v2' }),
    });

    renderHistory();

    const buttons = screen.getAllByRole('button', { name: /Ver versión/i });
    // First non-head button corresponds to seq 2
    await userEvent.click(buttons[0]!);

    await waitFor(() => {
      expect(buttons[0]).toHaveAttribute('aria-expanded', 'true');
    });
    // The other Ver button stays false
    expect(buttons[1]).toHaveAttribute('aria-expanded', 'false');
  });

  it('Diff button sets aria-expanded=true when diff panel opens', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ path: 'nota.md', from: 2, to: 3, diff: DIFF_RESULT }),
    });

    renderHistory();

    const diffButtons = screen.getAllByRole('button', { name: /Diff/i });
    await userEvent.click(diffButtons[0]!);

    await waitFor(() => {
      expect(diffButtons[0]).toHaveAttribute('aria-expanded', 'true');
    });
    expect(diffButtons[1]).toHaveAttribute('aria-expanded', 'false');
  });

  // ── Focus management ─────────────────────────────────────────────────────────

  it('panel heading receives focus after Ver versión opens', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ path: 'nota.md', seq: 2, hash: 'bbccddee', content: 'v2' }),
    });

    renderHistory();

    const buttons = screen.getAllByRole('button', { name: /Ver versión/i });
    await userEvent.click(buttons[0]!);

    await waitFor(() => {
      // Panel heading should contain the version label and be focused
      const heading = screen.getByText(/Versión seq 2/i);
      expect(document.activeElement).toBe(heading);
    });
  });

  it('panel heading receives focus after Diff opens', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ path: 'nota.md', from: 2, to: 3, diff: DIFF_RESULT }),
    });

    renderHistory();

    const diffButtons = screen.getAllByRole('button', { name: /Diff/i });
    await userEvent.click(diffButtons[0]!);

    await waitFor(() => {
      const heading = screen.getByText(/Diff seq 2/i);
      expect(document.activeElement).toBe(heading);
    });
  });

  it('panel heading has tabIndex -1 (programmatic focus only)', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ path: 'nota.md', seq: 2, hash: 'bbccddee', content: 'v2' }),
    });

    renderHistory();

    const buttons = screen.getAllByRole('button', { name: /Ver versión/i });
    await userEvent.click(buttons[0]!);

    await waitFor(() => {
      const heading = screen.getByText(/Versión seq 2/i);
      expect(heading).toHaveAttribute('tabIndex', '-1');
    });
  });
});
