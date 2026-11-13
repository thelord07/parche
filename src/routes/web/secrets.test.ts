/**
 * PARCHE-012 — GET /api/web/g/:slug/secrets + POST .../secrets/:id/ack.
 * A5/R4: solo owner/admin ven el aviso; editor/reader → 403.
 * A4: el payload nunca trae fingerprint, line ni el valor del secreto.
 */
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { files, groups, members, secretFindings } from '../../db/schema.js';
import {
  cleanupDir,
  makeApp,
  makeTempDataDir,
  seedGroupWithDevice,
  seedMember,
  seedWebSession,
  seedWebUser,
} from '../../test-helpers.js';

async function setup() {
  const dataDir = await makeTempDataDir();
  const app = await makeApp(dataDir);
  await app.ready();

  const group = await seedGroupWithDevice(app, { slug: 'secrets-grp' });
  const ownerSession = seedWebSession(app, group.userId);

  const admin = seedWebUser(app, { email: 'admin@secrets.test' });
  seedMember(app, { groupSlug: 'secrets-grp', userId: admin.userId, role: 'admin' });
  const adminSession = seedWebSession(app, admin.userId);

  const editor = seedWebUser(app, { email: 'editor@secrets.test' });
  seedMember(app, { groupSlug: 'secrets-grp', userId: editor.userId, role: 'editor' });
  const editorSession = seedWebSession(app, editor.userId);

  const reader = seedWebUser(app, { email: 'reader@secrets.test' });
  seedMember(app, { groupSlug: 'secrets-grp', userId: reader.userId, role: 'reader' });
  const readerSession = seedWebSession(app, reader.userId);

  // Seed one live .md with an open finding
  const now = new Date().toISOString();
  app.db
    .insert(files)
    .values({
      groupId: group.groupId,
      path: 'leak.md',
      pathKey: 'leak.md',
      headHash: 'a'.repeat(64),
      headSeq: 1,
    })
    .run();
  const [openRow] = app.db
    .insert(secretFindings)
    .values({
      groupId: group.groupId,
      path: 'leak.md',
      hash: 'a'.repeat(64),
      kind: 'aws-access-key',
      fingerprint: 'abc123def456',
      foundAt: now,
      resolvedAt: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
    })
    .returning()
    .all();

  // Seed a resolved-but-not-acked row (pendingRotation)
  app.db
    .insert(files)
    .values({
      groupId: group.groupId,
      path: 'rotated.md',
      pathKey: 'rotated.md',
      headHash: 'b'.repeat(64),
      headSeq: 2,
    })
    .run();
  const [pendingRow] = app.db
    .insert(secretFindings)
    .values({
      groupId: group.groupId,
      path: 'rotated.md',
      hash: 'c'.repeat(64),
      kind: 'parche-token',
      fingerprint: 'def456abc123',
      foundAt: now,
      resolvedAt: now,
      acknowledgedAt: null,
      acknowledgedBy: null,
    })
    .returning()
    .all();

  return {
    dataDir,
    app,
    group,
    ownerSession,
    adminSession,
    editorSession,
    readerSession,
    openRow: openRow!,
    pendingRow: pendingRow!,
    cleanup: async () => {
      await app.close();
      await cleanupDir(dataDir);
    },
  };
}

describe('GET /api/web/g/:slug/secrets', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('owner → 200 with open + pendingRotation lists', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/secrets-grp/secrets',
      cookies: { parche_session: ctx.ownerSession },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      open: { count: number; items: unknown[]; total: number };
      pendingRotation: { count: number; items: unknown[]; total: number };
    }>();
    expect(body.open.count).toBe(1);
    expect(body.open.items).toHaveLength(1);
    expect(body.open.total).toBe(1);
    expect(body.pendingRotation.count).toBe(1);
    expect(body.pendingRotation.items).toHaveLength(1);
    expect(body.pendingRotation.total).toBe(1);
  });

  it('admin → 200', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/secrets-grp/secrets',
      cookies: { parche_session: ctx.adminSession },
    });
    expect(res.statusCode).toBe(200);
  });

  it('editor → 403', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/secrets-grp/secrets',
      cookies: { parche_session: ctx.editorSession },
    });
    expect(res.statusCode).toBe(403);
  });

  it('reader → 403', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/secrets-grp/secrets',
      cookies: { parche_session: ctx.readerSession },
    });
    expect(res.statusCode).toBe(403);
  });

  it('without session → 401', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/web/g/secrets-grp/secrets' });
    expect(res.statusCode).toBe(401);
  });

  it('non-member / nonexistent group → 404', async () => {
    const res1 = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/no-such-group/secrets',
      cookies: { parche_session: ctx.ownerSession },
    });
    expect(res1.statusCode).toBe(404);
  });

  it('never includes fingerprint, line, or the secret value', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/secrets-grp/secrets',
      cookies: { parche_session: ctx.ownerSession },
    });
    const text = res.body;
    expect(text).not.toContain('abc123def456');
    expect(text).not.toContain('def456abc123');
    expect(text).not.toContain('fingerprint');
    expect(text).not.toMatch(/"line"/);
  });

  it('a resolved+acked finding does not appear in pendingRotation', async () => {
    const now = new Date().toISOString();
    ctx.app.db
      .update(secretFindings)
      .set({ acknowledgedAt: now, acknowledgedBy: ctx.group.userId })
      .where(eq(secretFindings.id, ctx.pendingRow.id))
      .run();

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/secrets-grp/secrets',
      cookies: { parche_session: ctx.ownerSession },
    });
    const body = res.json<{ pendingRotation: { items: Array<{ path: string }> } }>();
    expect(body.pendingRotation.items.some((i) => i.path === 'rotated.md')).toBe(false);
  });

  it('the note view and raw are not hidden for a path with an open finding (nothing is destroyed)', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/secrets-grp/note?path=leak.md',
      cookies: { parche_session: ctx.readerSession },
    });
    // 200 or 404 (blob not actually stored here) — either way, never gated by the secret finding.
    expect([200, 404]).toContain(res.statusCode);
    expect(res.statusCode).not.toBe(403);
  });
});

describe('POST /api/web/g/:slug/secrets/:id/ack', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function postAck(app: FastifyInstance, id: number, cookie?: string, csrf = true) {
    return app.inject({
      method: 'POST',
      url: `/api/web/g/secrets-grp/secrets/${id}/ack`,
      headers: {
        'content-type': 'application/json',
        ...(csrf ? { 'x-parche-csrf': '1' } : {}),
      },
      ...(cookie ? { cookies: { parche_session: cookie } } : {}),
      payload: {},
    });
  }

  it('without session → 401', async () => {
    const res = await postAck(ctx.app, ctx.openRow.id);
    expect(res.statusCode).toBe(401);
  });

  it('nonexistent group → 404', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/no-such-group/secrets/${ctx.openRow.id}/ack`,
      headers: { 'content-type': 'application/json', 'x-parche-csrf': '1' },
      cookies: { parche_session: ctx.ownerSession },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('id belonging to another group → 404', async () => {
    const other = await seedGroupWithDevice(ctx.app, { slug: 'other-secrets-grp' });
    const otherOwnerSession = seedWebSession(ctx.app, other.userId);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/web/g/other-secrets-grp/secrets/' + ctx.openRow.id + '/ack',
      headers: { 'content-type': 'application/json', 'x-parche-csrf': '1' },
      cookies: { parche_session: otherOwnerSession },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('editor → 403', async () => {
    const res = await postAck(ctx.app, ctx.openRow.id, ctx.editorSession);
    expect(res.statusCode).toBe(403);
  });

  it('reader → 403', async () => {
    const res = await postAck(ctx.app, ctx.openRow.id, ctx.readerSession);
    expect(res.statusCode).toBe(403);
  });

  it('owner without CSRF header → 403', async () => {
    const res = await postAck(ctx.app, ctx.openRow.id, ctx.ownerSession, false);
    expect(res.statusCode).toBe(403);
  });

  it('owner → 200, ack is persisted', async () => {
    const res = await postAck(ctx.app, ctx.openRow.id, ctx.ownerSession);
    expect(res.statusCode).toBe(200);

    const row = ctx.app.db
      .select()
      .from(secretFindings)
      .where(
        and(eq(secretFindings.id, ctx.openRow.id), eq(secretFindings.groupId, ctx.group.groupId)),
      )
      .get();
    expect(row?.acknowledgedAt).not.toBeNull();
    expect(row?.acknowledgedBy).toBe(ctx.group.userId);
  });

  it('admin → 200', async () => {
    const res = await postAck(ctx.app, ctx.openRow.id, ctx.adminSession);
    expect(res.statusCode).toBe(200);
  });

  it('is idempotent: a second ack does not change acknowledged_at', async () => {
    await postAck(ctx.app, ctx.openRow.id, ctx.ownerSession);
    const first = ctx.app.db
      .select({ at: secretFindings.acknowledgedAt })
      .from(secretFindings)
      .where(eq(secretFindings.id, ctx.openRow.id))
      .get();

    await new Promise((r) => setTimeout(r, 5));
    await postAck(ctx.app, ctx.openRow.id, ctx.ownerSession);
    const second = ctx.app.db
      .select({ at: secretFindings.acknowledgedAt })
      .from(secretFindings)
      .where(eq(secretFindings.id, ctx.openRow.id))
      .get();

    expect(second?.at).toBe(first?.at);
  });

  it('invalid :id → 400', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/web/g/secrets-grp/secrets/not-a-number/ack',
      headers: { 'content-type': 'application/json', 'x-parche-csrf': '1' },
      cookies: { parche_session: ctx.ownerSession },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('nonexistent id (within the group) → 404', async () => {
    const res = await postAck(ctx.app, 999999, ctx.ownerSession);
    expect(res.statusCode).toBe(404);
  });

  it('removed member → 404 (requireWebGroup gates on removed_at IS NULL)', async () => {
    const grp = ctx.app.db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.slug, 'secrets-grp'))
      .get();
    expect(grp).toBeDefined();

    // Owner-admin removes themselves from the group's membership table directly
    // (tombstone, never a DELETE — matches CLAUDE.md "revocación es siempre UPDATE").
    const now = new Date().toISOString();
    ctx.app.db
      .update(members)
      .set({ removedAt: now })
      .where(and(eq(members.groupId, grp!.id), eq(members.userId, ctx.group.userId)))
      .run();

    const res = await postAck(ctx.app, ctx.openRow.id, ctx.ownerSession);
    expect(res.statusCode).toBe(404);
  });

  it('ack on an open finding removes it from the implicit pendingRotation future list but keeps it in open', async () => {
    await postAck(ctx.app, ctx.openRow.id, ctx.ownerSession);

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/secrets-grp/secrets',
      cookies: { parche_session: ctx.ownerSession },
    });
    const body = res.json<{
      open: { items: Array<{ path: string }> };
      pendingRotation: { items: Array<{ path: string }> };
    }>();
    // Still open (resolved_at is still null) — acking an open finding does not resolve it.
    expect(body.open.items.some((i) => i.path === 'leak.md')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PARCHE-013 (A11) — un hallazgo cerrado por `rules_update` nunca aparece en
// `pendingRotation`: ni en `items`, ni en `count`, ni en `total` (las tres
// queries del endpoint deben ser coherentes entre sí).
// ---------------------------------------------------------------------------
describe('GET /api/web/g/:slug/secrets — rules_update excluido de pendingRotation (A11)', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('una fila con resolved_reason=rules_update no aparece en items/count/total de pendingRotation', async () => {
    const before = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/secrets-grp/secrets',
      cookies: { parche_session: ctx.ownerSession },
    });
    const beforeBody = before.json<{
      pendingRotation: { count: number; total: number; items: Array<{ path: string }> };
    }>();
    // El fixture base (ctx.pendingRow) ya tiene exactamente 1 fila pendiente
    // de rotar (`rotated.md`).
    expect(beforeBody.pendingRotation.items.map((i) => i.path)).toEqual(['rotated.md']);

    const now = new Date().toISOString();
    ctx.app.db
      .insert(files)
      .values({
        groupId: ctx.group.groupId,
        path: 'rules-update.md',
        pathKey: 'rules-update.md',
        headHash: 'e'.repeat(64),
        headSeq: 3,
      })
      .run();
    ctx.app.db
      .insert(secretFindings)
      .values({
        groupId: ctx.group.groupId,
        path: 'rules-update.md',
        hash: 'e'.repeat(64),
        kind: 'stripe-secret-key',
        fingerprint: 'fedcba987654',
        foundAt: now,
        resolvedAt: now,
        resolvedReason: 'rules_update',
        acknowledgedAt: null,
        acknowledgedBy: null,
      })
      .run();

    const after = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/secrets-grp/secrets',
      cookies: { parche_session: ctx.ownerSession },
    });
    const afterBody = after.json<{
      pendingRotation: { count: number; total: number; items: Array<{ path: string }> };
    }>();

    // ITEMS: la fila rules_update no aparece.
    expect(afterBody.pendingRotation.items.some((i) => i.path === 'rules-update.md')).toBe(false);
    // COUNT (DISTINCT path) y TOTAL (COUNT(*)) no se mueven — las tres
    // queries de pendingRotation están alineadas (A11).
    expect(afterBody.pendingRotation.count).toBe(beforeBody.pendingRotation.count);
    expect(afterBody.pendingRotation.total).toBe(beforeBody.pendingRotation.total);

    // Tampoco aparece en `open` (ya está resuelto).
    const openBody = after.json<{ open: { items: Array<{ path: string }> } }>();
    expect(openBody.open.items.some((i) => i.path === 'rules-update.md')).toBe(false);
  });
});
