import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sessions, users } from '../db/schema.js';
import { hashToken } from './tokens.js';

export interface WebUser {
  id: string;
  name: string;
  email: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    webUser: WebUser | null;
  }
}

export const COOKIE_NAME = 'parche_session';
/** 30 days in seconds */
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

/**
 * Middleware to validate a web session cookie.
 * Sets request.webUser if valid, or sends 401 if missing/invalid.
 * Must be registered as a preHandler on protected routes.
 */
export async function requireWebSession(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const secret = request.cookies[COOKIE_NAME];
  if (!secret) {
    return reply.status(401).send({ error: 'unauthorized' });
  }
  const tokenHash = hashToken(secret);
  const now = new Date().toISOString();

  const row = request.server.db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)))
    .get();

  if (!row || row.expiresAt < now) {
    return reply.status(401).send({ error: 'unauthorized' });
  }

  request.webUser = { id: row.userId, name: row.name, email: row.email };
}
