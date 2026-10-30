import type { FastifyInstance } from 'fastify';
import { createGroupForUser } from '../../admin/commands.js';
import { csrfHook } from '../../auth/csrf.js';
import { requireWebSession, type WebUser } from '../../auth/web-session.js';
import type { Config } from '../../config.js';

const SLUG_RE = /^[a-z0-9-]{3,40}$/;

export interface GroupsRouteOptions {
  config: Config;
}

export async function webGroupsRoutes(
  app: FastifyInstance,
  opts: GroupsRouteOptions,
): Promise<void> {
  const { config } = opts;

  // -------------------------------------------------------------------------
  // POST /api/web/groups
  // -------------------------------------------------------------------------
  app.post<{ Body: { name?: unknown; slug?: unknown } }>(
    '/api/web/groups',
    { preHandler: [csrfHook, requireWebSession] },
    async (request, reply) => {
      const webUser = request.webUser as WebUser;

      // Only creators can create groups
      if (!config.creators.includes(webUser.email.toLowerCase())) {
        return reply.status(403).send({ error: 'forbidden' });
      }

      const body = request.body as { name?: unknown; slug?: unknown };
      if (typeof body.name !== 'string' || typeof body.slug !== 'string') {
        return reply.status(400).send({ error: 'bad_request' });
      }

      const name = body.name.trim();
      const slug = body.slug.trim();

      if (!name || !SLUG_RE.test(slug)) {
        return reply.status(400).send({ error: 'bad_request' });
      }

      let groupId: string;
      try {
        ({ groupId } = createGroupForUser(app.db, { name, slug, userId: webUser.id }));
      } catch (err: unknown) {
        // SQLite unique constraint violation
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('SQLITE_CONSTRAINT_UNIQUE') || msg.includes('UNIQUE constraint failed')) {
          return reply.status(409).send({ error: 'slug_taken' });
        }
        throw err;
      }

      return reply.status(200).send({ groupId, slug, name });
    },
  );
}
