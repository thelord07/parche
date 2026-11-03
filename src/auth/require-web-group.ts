import type { Role } from '@chamba/core';
import { can } from '@chamba/core';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { groups, members } from '../db/schema.js';
import { requireWebSession, type WebUser } from './web-session.js';

export interface WebGroup {
  groupId: string;
  slug: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    webGroup: WebGroup | null;
  }
}

/**
 * preHandler factory: requireWebSession → resolve group by slug → check active membership.
 * Returns 401 if no session, 404 if group not found or user not an active member
 * (covers removed, revoked, or non-existent membership).
 * Sets request.webGroup on success.
 */
export function requireWebGroup(action = 'read') {
  return async function webGroupPreHandler(
    request: FastifyRequest<{ Params: { slug: string } }>,
    reply: FastifyReply,
  ): Promise<void> {
    // 1. Require web session (sends 401 if missing/invalid)
    await requireWebSession(request, reply);
    if (reply.sent) return;

    const webUser = request.webUser as WebUser;
    const { slug } = request.params;

    // 2. Validate slug — no traversal characters
    if (!slug || /[./\\]/.test(slug)) {
      return reply.status(404).send({ error: 'not_found' });
    }

    // 3. Resolve group by slug (DB lookup only, no filesystem)
    const grp = request.server.db
      .select({ id: groups.id, name: groups.name, slug: groups.slug })
      .from(groups)
      .where(eq(groups.slug, slug))
      .get();

    if (!grp) {
      return reply.status(404).send({ error: 'not_found' });
    }

    // 4. Check active membership (removed_at IS NULL)
    const member = request.server.db
      .select({ role: members.role })
      .from(members)
      .where(
        and(eq(members.groupId, grp.id), eq(members.userId, webUser.id), isNull(members.removedAt)),
      )
      .get();

    if (!member) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const role = member.role as Role;

    // 5. Permission check for non-read actions
    if (action !== 'read' && !can(role, action as Parameters<typeof can>[1])) {
      return reply.status(403).send({ error: 'forbidden' });
    }

    request.webGroup = { groupId: grp.id, slug: grp.slug, role };
  };
}
