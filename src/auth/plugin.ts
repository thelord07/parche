import type { Role, SyncAction } from '@chamba/core';
import { can } from '@chamba/core';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { devices, groups, members } from '../db/schema.js';
import { hashToken } from './tokens.js';

// ---------------------------------------------------------------------------
// Request decoration — typed auth context set by `authenticate`
// ---------------------------------------------------------------------------

export interface RequestAuth {
  deviceId: string;
  userId: string;
  groupId: string;
  groupSlug: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: RequestAuth;
  }
}

/**
 * Register the `auth` decorator on the Fastify instance.
 * Must be called BEFORE any route that uses `authenticate`.
 */
export function registerAuth(app: FastifyInstance): void {
  app.decorateRequest('auth', null as unknown as RequestAuth);
}

// ---------------------------------------------------------------------------
// authenticate — preHandler that validates Bearer token and sets request.auth
// ---------------------------------------------------------------------------

export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'unauthorized' });
  }
  const token = authHeader.slice(7);
  if (!token.startsWith('pch_')) {
    return reply.status(401).send({ error: 'unauthorized' });
  }

  const tokenHash = hashToken(token);

  // Single join: device + group in one query
  const row = request.server.db
    .select({
      deviceId: devices.id,
      userId: devices.userId,
      groupId: devices.groupId,
      revokedAt: devices.revokedAt,
      groupSlug: groups.slug,
    })
    .from(devices)
    .innerJoin(groups, eq(devices.groupId, groups.id))
    .where(eq(devices.tokenHash, tokenHash))
    .get();

  if (!row || row.revokedAt !== null) {
    return reply.status(401).send({ error: 'unauthorized' });
  }

  // Verify the member is still active (not removed)
  const member = request.server.db
    .select({ role: members.role })
    .from(members)
    .where(
      and(
        eq(members.groupId, row.groupId),
        eq(members.userId, row.userId),
        isNull(members.removedAt),
      ),
    )
    .get();

  if (!member) {
    return reply.status(401).send({ error: 'unauthorized' });
  }

  // When the route has a :slug param, verify it matches the device's group
  const params = request.params as { slug?: string };
  if (params.slug !== undefined && params.slug !== row.groupSlug) {
    return reply.status(401).send({ error: 'unauthorized' });
  }

  // Update last_seen_at (synchronous — better-sqlite3 is sync)
  request.server.db
    .update(devices)
    .set({ lastSeenAt: new Date().toISOString() })
    .where(eq(devices.id, row.deviceId))
    .run();

  request.auth = {
    deviceId: row.deviceId,
    userId: row.userId,
    groupId: row.groupId,
    groupSlug: row.groupSlug,
    role: member.role as Role,
  };
}

// ---------------------------------------------------------------------------
// requireCan — factory returning a preHandler that enforces a permission
// ---------------------------------------------------------------------------

export function requireCan(action: SyncAction) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!can(request.auth.role, action)) {
      return reply.status(403).send({ error: 'forbidden' });
    }
  };
}
