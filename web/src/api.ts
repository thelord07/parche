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

// ─── Branded type for sanitized HTML (O1) ────────────────────────────────────
// Only api.getNote may produce a value of this type (via `as SanitizedHtml`).
// note-article.tsx is the ONLY consumer; xss-static-scan.test.ts enforces this.
declare const _htmlBrand: unique symbol;
export type SanitizedHtml = string & { readonly [_htmlBrand]: 'SanitizedHtml' };

// ─── Existing types ────────────────────────────────────────────────────────────

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

// ─── Group / dashboard types ──────────────────────────────────────────────────

export interface SummaryResponse {
  group: { slug: string; name: string; role: string };
  notes: number;
  folders: number;
  conflicts: number;
  lastChangeAt: string | null;
  members: Array<{ name: string; email: string; role: string }>;
}

export interface TreeItem {
  name: string;
  type: 'dir' | 'file';
  count?: number;
  title?: string;
  hash?: string;
}

export interface TreeResponse {
  path: string;
  items: TreeItem[];
}

export interface ActivityEvent {
  seq: number;
  path: string;
  verb: string;
  hash: string | null;
  hashCorto?: string;
  user: { name: string; email: string };
  deviceLabel: string;
  at: string;
  project?: string;
  workItem?: string;
  renamedTo?: string;
  /** Number of saves collapsed into this event by the 10-min grouping window. */
  count?: number;
}

export interface ActivityResponse {
  events: ActivityEvent[];
  hasMore: boolean;
  nextBefore: number | null;
}

// ─── Note types ────────────────────────────────────────────────────────────────

export interface NoteVersion {
  seq: number;
  hash: string | null;
  hashShort?: string;
  at: string;
  user: string;
  deviceLabel: string;
}

export interface NoteBacklink {
  path: string;
  title?: string;
  snippet?: string;
}

export interface NoteMeta {
  title?: string | null;
  summary?: string | null;
  type?: string | null;
  tags: string[];
  workItem?: string | null;
  project?: string | null;
  conflictOf?: string | null;
  conflictBase?: string | null;
}

export interface NoteHead {
  hash: string;
  hashShort: string;
  seq: number;
  at: string;
  user: { name: string; email: string };
  deviceLabel: string;
}

export interface NoteResponse {
  path: string;
  title: string | null;
  metaPending: boolean;
  meta: NoteMeta | null;
  head: NoteHead | null;
  versions: NoteVersion[];
  backlinks: NoteBacklink[];
  html: SanitizedHtml;
}

export interface NoteVersionContent {
  path: string;
  seq: number;
  hash: string;
  content: string;
}

export interface DiffEntry {
  kind: 'eq' | 'mod' | 'add' | 'del';
  old?: string;
  new?: string;
}

export interface DiffResponse {
  path: string;
  from: number;
  to: number;
  diff: DiffEntry[];
}

// ─── Conflict types ────────────────────────────────────────────────────────────

export interface ConflictRow {
  copyPath: string;
  originalPath: string | null;
  base: string | null;
  autorCopia: string | null;
  at: string | null;
}

export interface ConflictFileInfo {
  path: string;
  hash: string;
  hashShort: string;
  content: string;
  author: string | null;
  device: string | null;
  at: string | null;
}

export interface ConflictViewResponse {
  copyPath: string;
  originalPath: string;
  base: string | null;
  original: ConflictFileInfo | null;
  copy: ConflictFileInfo | null;
  diff: DiffEntry[];
}

// ─── Topics types ──────────────────────────────────────────────────────────────

export interface TopicsNode {
  tag: string;
  count: number;
}

export interface TopicsResponse {
  nodes: TopicsNode[];
}

// ─── API client ────────────────────────────────────────────────────────────────

export const api = {
  // Auth / account
  getMe: () => apiFetch<MeResponse>('/api/web/me', 'GET'),

  requestMagicLink: (email: string) =>
    apiFetch<{ ok: boolean }>('/api/web/auth/request', 'POST', { email }),

  verifyToken: (token: string) =>
    apiFetch<{ ok: boolean }>('/api/web/auth/verify', 'POST', { token }),

  logout: () => apiFetch<{ ok: boolean }>('/api/web/auth/logout', 'POST'),

  // Groups
  createGroup: (name: string, slug: string) =>
    apiFetch<{ groupId: string; slug: string; name: string }>('/api/web/groups', 'POST', {
      name,
      slug,
    }),

  // Invites
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

  // ─── Group read (PARCHE-007-A) ──────────────────────────────────────────────

  getSummary: (slug: string) => apiFetch<SummaryResponse>(`/api/web/g/${slug}/summary`, 'GET'),

  getTree: (slug: string, path?: string) =>
    apiFetch<TreeResponse>(
      `/api/web/g/${slug}/tree${path ? `?path=${encodeURIComponent(path)}` : ''}`,
      'GET',
    ),

  getActivity: (slug: string, params?: { before?: number; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.before !== undefined) qs.set('before', String(params.before));
    if (params?.limit !== undefined) qs.set('limit', String(params.limit));
    const q = qs.toString();
    return apiFetch<ActivityResponse>(`/api/web/g/${slug}/activity${q ? `?${q}` : ''}`, 'GET');
  },

  /** Returns the note with server-rendered sanitized html (O1). */
  getNote: (slug: string, path: string) =>
    apiFetch<Omit<NoteResponse, 'html'> & { html: string }>(
      `/api/web/g/${slug}/note?path=${encodeURIComponent(path)}`,
      'GET',
    ).then((r) => ({ ...r, html: r.html as SanitizedHtml })),

  getNoteVersion: (slug: string, path: string, seq: number) =>
    apiFetch<NoteVersionContent>(
      `/api/web/g/${slug}/note/version?path=${encodeURIComponent(path)}&seq=${seq}`,
      'GET',
    ),

  getDiff: (slug: string, path: string, from: number, to: number) =>
    apiFetch<DiffResponse>(
      `/api/web/g/${slug}/diff?path=${encodeURIComponent(path)}&from=${from}&to=${to}`,
      'GET',
    ),

  getConflicts: (slug: string) => apiFetch<ConflictRow[]>(`/api/web/g/${slug}/conflicts`, 'GET'),

  getConflictView: (slug: string, copyPath: string) =>
    apiFetch<ConflictViewResponse>(
      `/api/web/g/${slug}/conflicts/view?copyPath=${encodeURIComponent(copyPath)}`,
      'GET',
    ),

  getTopics: (slug: string) => apiFetch<TopicsResponse>(`/api/web/g/${slug}/topics`, 'GET'),

  /** Build a raw asset URL (never fetched directly by this module). */
  rawUrl: (slug: string, path: string, seq?: number): string => {
    const base = `/api/web/g/${slug}/raw?path=${encodeURIComponent(path)}`;
    return seq !== undefined ? `${base}&seq=${seq}` : base;
  },
};
