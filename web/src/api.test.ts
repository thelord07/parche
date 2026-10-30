/**
 * Unit tests for apiFetch / api client.
 *
 * (a) revokeInvite and logout must send body='{}' with Content-Type: application/json
 *     and X-Parche-CSRF: 1, even though they have no logical payload.
 *     Without this, Fastify rejects them with FST_ERR_CTP_EMPTY_JSON_BODY (400).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api.ts';

function mockFetchOk(json: unknown = { ok: true }) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => json,
  });
}

describe('api client — mutation body', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('revokeInvite sends body={} with correct headers', async () => {
    mockFetchOk({ ok: true });

    await api.revokeInvite('my-group', 'invite-id-123');

    expect(global.fetch).toHaveBeenCalledOnce();
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];

    expect(init.body).toBe('{}');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((init.headers as Record<string, string>)['X-Parche-CSRF']).toBe('1');
  });

  it('logout sends body={} with correct headers', async () => {
    mockFetchOk({ ok: true });

    await api.logout();

    expect(global.fetch).toHaveBeenCalledOnce();
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];

    expect(init.body).toBe('{}');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((init.headers as Record<string, string>)['X-Parche-CSRF']).toBe('1');
  });

  it('createGroup sends the real payload (not {})', async () => {
    mockFetchOk({ groupId: '1', slug: 'test', name: 'Test' });

    await api.createGroup('Test', 'test');

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(init.body).toBe(JSON.stringify({ name: 'Test', slug: 'test' }));
  });

  it('getMe does NOT set Content-Type or body (GET)', async () => {
    mockFetchOk({ user: { id: '1', name: 'A', email: 'a@b.com' }, groups: [] });

    await api.getMe();

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });
});
