import { changesResponseSchema } from '@chamba/core';
import { and, eq, gt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { authenticate, requireCan } from '../auth/plugin.js';
import { changes, devices, users } from '../db/schema.js';

export async function changesRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { slug: string }; Querystring: { since?: string; limit?: string } }>(
    '/api/g/:slug/changes',
    { preHandler: [authenticate, requireCan('read')] },
    async (request, reply) => {
      // since defaults to 0, must be integer >= 0
      const sinceRaw = parseInt(request.query.since ?? '0', 10);
      const since = Number.isNaN(sinceRaw) || sinceRaw < 0 ? 0 : sinceRaw;

      // limit defaults to 500, clamped to 1..1000
      const limitRaw = parseInt(request.query.limit ?? '500', 10);
      const limit = Number.isNaN(limitRaw) ? 500 : Math.min(1000, Math.max(1, limitRaw));

      const rows = app.db
        .select({
          seq: changes.seq,
          path: changes.path,
          hash: changes.hash,
          at: changes.at,
          author: users.name,
          device: devices.label,
        })
        .from(changes)
        .innerJoin(users, eq(changes.userId, users.id))
        .innerJoin(devices, eq(changes.deviceId, devices.id))
        .where(and(eq(changes.groupId, request.auth.groupId), gt(changes.seq, since)))
        .orderBy(changes.seq)
        .limit(limit + 1)
        .all();

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const lastRow = page[page.length - 1];
      const cursor = lastRow !== undefined ? lastRow.seq : since;

      const body = changesResponseSchema.parse({ protocol: 1, changes: page, hasMore, cursor });
      return reply.status(200).send(body);
    },
  );
}
