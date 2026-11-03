import { and, eq, isNotNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireWebGroup } from '../../auth/require-web-group.js';
import { fileMeta } from '../../db/schema.js';

const RL_READ = {
  config: {
    rateLimit: {
      max: 300,
      timeWindow: '1 minute',
      keyGenerator: (req: { cookies: Record<string, string | undefined> }) =>
        req.cookies?.['parche_session'] ?? 'anon',
    },
  },
};

export async function topicsRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /api/web/g/:slug/topics
  // -------------------------------------------------------------------------
  app.get<{ Params: { slug: string } }>(
    '/api/web/g/:slug/topics',
    { preHandler: [requireWebGroup('read')], ...RL_READ },
    async (request, reply) => {
      const { groupId } = request.webGroup!;

      const metaRows = app.db
        .select({ tagsJson: fileMeta.tagsJson })
        .from(fileMeta)
        .where(and(eq(fileMeta.groupId, groupId), isNotNull(fileMeta.tagsJson)))
        .all();

      const tree = new Map<string, number>();
      for (const row of metaRows) {
        if (!row.tagsJson) continue;
        try {
          const tags = JSON.parse(row.tagsJson) as string[];
          for (const tag of tags) {
            if (typeof tag === 'string' && tag.startsWith('tema/')) {
              tree.set(tag, (tree.get(tag) ?? 0) + 1);
            }
          }
        } catch {
          // ignore malformed JSON
        }
      }

      const nodes = Array.from(tree.entries())
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => a.tag.localeCompare(b.tag));

      return reply.status(200).send({ nodes });
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/web/g/:slug/topics/* (splat)
  // -------------------------------------------------------------------------
  app.get<{ Params: { slug: string; '*': string } }>(
    '/api/web/g/:slug/topics/*',
    { preHandler: [requireWebGroup('read')], ...RL_READ },
    async (request, reply) => {
      const { groupId } = request.webGroup!;
      const tag = 'tema/' + (request.params['*'] ?? '');

      const metaRows = app.db
        .select({ path: fileMeta.path, title: fileMeta.title, tagsJson: fileMeta.tagsJson })
        .from(fileMeta)
        .where(and(eq(fileMeta.groupId, groupId), isNotNull(fileMeta.tagsJson)))
        .all();

      const matchingFiles: Array<{ path: string; title: string | null }> = [];
      for (const row of metaRows) {
        if (!row.tagsJson) continue;
        try {
          const tags = JSON.parse(row.tagsJson) as string[];
          if (tags.includes(tag)) {
            matchingFiles.push({ path: row.path, title: row.title });
          }
        } catch {
          // ignore
        }
      }

      return reply.status(200).send({ tag, files: matchingFiles });
    },
  );
}
