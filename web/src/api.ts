type Method = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

async function apiFetch<T>(url: string, method: Method, body?: unknown): Promise<T> {
  const isMutation = method !== 'GET';
  const headers: Record<string, string> = {};
  if (isMutation) {
    headers['Content-Type'] = 'application/json';
    headers['X-Parche-CSRF'] = '1';
  }

  const resp = await fetch(url, {
    method,
    headers,
    body: isMutation ? JSON.stringify(body ?? {}) : undefined,
    credentials: 'same-origin',
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: 'unknown' }));
    throw Object.assign(new Error((err as { error?: string }).error ?? 'error'), {
      status: resp.status,
      body: err,
    });
  }

  return resp.json() as Promise<T>;
}

export interface MeResponse {
  user: { id: string; name: string; email: string };
  groups: Array<{ slug: string; name: string; role: string }>;
}

export interface InviteRow {
  id: string;
  codeDisplay: string;
  role: string;
  expiresAt: string | null;
  maxUses: number | null;
  uses: number;
  createdBy: string;
  createdAt: string;
}

export interface InviteCheckResult {
  valid: boolean;
  group?: { name: string; slug: string };
  role?: string;
  inviter?: string;
  expiresLabel?: string;
}

export const api = {
  getMe: () => apiFetch<MeResponse>('/api/web/me', 'GET'),

  requestMagicLink: (email: string) =>
    apiFetch<{ ok: boolean }>('/api/web/auth/request', 'POST', { email }),

  verifyToken: (token: string) =>
    apiFetch<{ ok: boolean }>('/api/web/auth/verify', 'POST', { token }),

  logout: () => apiFetch<{ ok: boolean }>('/api/web/auth/logout', 'POST'),

  createGroup: (name: string, slug: string) =>
    apiFetch<{ groupId: string; slug: string; name: string }>('/api/web/groups', 'POST', {
      name,
      slug,
    }),

  getInvites: (slug: string) => apiFetch<InviteRow[]>(`/api/web/groups/${slug}/invites`, 'GET'),

  createInvite: (slug: string, role: string, expires: string, maxUses: number | null) =>
    apiFetch<{ code: string }>(`/api/web/groups/${slug}/invites`, 'POST', {
      role,
      expires,
      maxUses,
    }),

  revokeInvite: (slug: string, id: string) =>
    apiFetch<{ ok: boolean }>(`/api/web/groups/${slug}/invites/${id}/revoke`, 'POST'),

  checkInvite: (code: string) =>
    apiFetch<InviteCheckResult>(`/api/web/invites/${code}/check`, 'GET'),
};
