/**
 * PARCHE-012 — aviso de secretos en el dashboard (solo owner/admin, A5/R4).
 * GET nunca devuelve `fingerprint`, `line` ni el valor del secreto (A4):
 * solo `id` (opaco), `path`, `kind` y fechas.
 */
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { csrfHook } from '../../auth/csrf.js';
import { requireWebGroup } from '../../auth/require-web-group.js';
import type { WebUser } from '../../auth/web-session.js';
import { files, secretFindings } from '../../db/schema.js';

const ITEMS_LIMIT = 200;

/** Rate limit de lectura — igual patrón que group-read.ts / members.ts */
const RL_READ = {
  config: {
    rateLimit: {
      max: 300,
      timeWindow: '1 minute',
      keyGenerator: (req: { cookies: Record<string, string | undefined> }) =>
        req.cookies?.parche_session ?? 'anon',
    },
  },
};

/** Rate limit de escritura — igual patrón que members.ts */
const RL_WRITE = {
  config: {
    rateLimit: {
      max: 30,
      timeWindow: '1 minute',
      keyGenerator: (req: { cookies: Record<string, string | undefined> }) =>
        req.cookies?.parche_session ?? 'anon',
    },
  },
};

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

function isOwnerOrAdmin(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

export async function secretsRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /api/web/g/:slug/secrets
  // -------------------------------------------------------------------------
  app.get<{ Params: { slug: string } }>(
    '/api/web/g/:slug/secrets',
    { preHandler: [requireWebGroup('read')], ...RL_READ },
    async (request, reply) => {
      const { groupId, role } = request.webGroup!;

      // A5 — equivale a can(role,'invite'), explícito para que la intención se lea.
      if (!isOwnerOrAdmin(role)) {
        return reply.status(403).send({ error: 'forbidden' });
      }

      // open: resolved_at IS NULL y la ruta sigue viva.
      const openRows = app.db
        .select({
          id: secretFindings.id,
          path: secretFindings.path,
          kind: secretFindings.kind,
          since: secretFindings.foundAt,
        })
        .from(secretFindings)
        .innerJoin(
          files,
          and(eq(files.groupId, secretFindings.groupId), eq(files.path, secretFindings.path)),
        )
        .where(
          and(
            eq(secretFindings.groupId, groupId),
            isNull(secretFindings.resolvedAt),
            isNotNull(files.headHash),
          ),
        )
        .orderBy(desc(secretFindings.foundAt))
        .limit(ITEMS_LIMIT + 1)
        .all();

      const openHasMore = openRows.length > ITEMS_LIMIT;
      const openItems = openHasMore ? openRows.slice(0, ITEMS_LIMIT) : openRows;

      const openCountRow = app.db
        .select({ count: sql<number>`COUNT(DISTINCT ${secretFindings.path})` })
        .from(secretFindings)
        .innerJoin(
          files,
          and(eq(files.groupId, secretFindings.groupId), eq(files.path, secretFindings.path)),
        )
        .where(
          and(
            eq(secretFindings.groupId, groupId),
            isNull(secretFindings.resolvedAt),
            isNotNull(files.headHash),
          ),
        )
        .get();

      // Total row (finding) count for this list — lets the front compute exactly
      // how many items are hidden beyond ITEMS_LIMIT ("y N más…"), unlike `count`
      // above which is DISTINCT paths, not item rows.
      const openTotalRow = app.db
        .select({ total: sql<number>`COUNT(*)` })
        .from(secretFindings)
        .innerJoin(
          files,
          and(eq(files.groupId, secretFindings.groupId), eq(files.path, secretFindings.path)),
        )
        .where(
          and(
            eq(secretFindings.groupId, groupId),
            isNull(secretFindings.resolvedAt),
            isNotNull(files.headHash),
          ),
        )
        .get();

      // pendingRotation: ya resuelto pero sin acuse — incluye rutas borradas (D2).
      const pendingRows = app.db
        .select({
          id: secretFindings.id,
          path: secretFindings.path,
          kind: secretFindings.kind,
          since: secretFindings.foundAt,
          resolvedAt: secretFindings.resolvedAt,
        })
        .from(secretFindings)
        .where(
          and(
            eq(secretFindings.groupId, groupId),
            isNotNull(secretFindings.resolvedAt),
            isNull(secretFindings.acknowledgedAt),
          ),
        )
        .orderBy(desc(secretFindings.resolvedAt))
        .limit(ITEMS_LIMIT + 1)
        .all();

      const pendingHasMore = pendingRows.length > ITEMS_LIMIT;
      const pendingItems = pendingHasMore ? pendingRows.slice(0, ITEMS_LIMIT) : pendingRows;

      const pendingCountRow = app.db
        .select({ count: sql<number>`COUNT(DISTINCT ${secretFindings.path})` })
        .from(secretFindings)
        .where(
          and(
            eq(secretFindings.groupId, groupId),
            isNotNull(secretFindings.resolvedAt),
            isNull(secretFindings.acknowledgedAt),
          ),
        )
        .get();

      const pendingTotalRow = app.db
        .select({ total: sql<number>`COUNT(*)` })
        .from(secretFindings)
        .where(
          and(
            eq(secretFindings.groupId, groupId),
            isNotNull(secretFindings.resolvedAt),
            isNull(secretFindings.acknowledgedAt),
          ),
        )
        .get();

      return reply.status(200).send({
        open: {
          count: openCountRow?.count ?? 0,
          items: openItems,
          hasMore: openHasMore,
          total: openTotalRow?.total ?? openItems.length,
        },
        pendingRotation: {
          count: pendingCountRow?.count ?? 0,
          items: pendingItems,
          hasMore: pendingHasMore,
          total: pendingTotalRow?.total ?? pendingItems.length,
        },
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/web/g/:slug/secrets/:id/ack — "Ya roté la credencial"
  // Idempotente, UPDATE únicamente (nunca borra).
  // -------------------------------------------------------------------------
  app.post<{ Params: { slug: string; id: string } }>(
    '/api/web/g/:slug/secrets/:id/ack',
    { preHandler: [csrfHook, requireWebGroup('read')], ...RL_WRITE },
    async (request, reply) => {
      const { groupId, role } = request.webGroup!;
      const webUser = request.webUser as WebUser;

      if (!isOwnerOrAdmin(role)) {
        return reply.status(403).send({ error: 'forbidden' });
      }

      const parsed = idParamSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'invalid_id' });
      }
      const { id } = parsed.data;

      const row = app.db
        .select({ id: secretFindings.id, acknowledgedAt: secretFindings.acknowledgedAt })
        .from(secretFindings)
        .where(and(eq(secretFindings.id, id), eq(secretFindings.groupId, groupId)))
        .get();

      if (!row) {
        return reply.status(404).send({ error: 'not_found' });
      }

      // Idempotente: un re-ack no cambia acknowledged_at.
      if (row.acknowledgedAt === null) {
        const now = new Date().toISOString();
        app.db
          .update(secretFindings)
          .set({ acknowledgedAt: now, acknowledgedBy: webUser.id })
          .where(and(eq(secretFindings.id, id), eq(secretFindings.groupId, groupId)))
          .run();
      }

      return reply.status(200).send({ ok: true });
    },
  );
}
