import type { Role } from '@chamba/core';
import { can } from '@chamba/core';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { INVITE_ROLES } from '../../admin/commands.js';
import { csrfHook } from '../../auth/csrf.js';
import { generateInviteCode, hashInviteCode, parseExpiry } from '../../auth/tokens.js';
import { requireWebSession, type WebUser } from '../../auth/web-session.js';
import { groups, invites, members, users } from '../../db/schema.js';
import { newId } from '../../ids.js';

export async function webInvitesRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /api/web/groups/:slug/invites
  // -------------------------------------------------------------------------
  app.get<{ Params: { slug: string } }>(
    '/api/web/groups/:slug/invites',
    { preHandler: [requireWebSession] },
    async (request, reply) => {
      const webUser = request.webUser as WebUser;
      const { slug } = request.params;

      // Find group
      const grp = app.db
        .select({ id: groups.id, name: groups.name })
        .from(groups)
        .where(eq(groups.slug, slug))
        .get();

      if (!grp) {
        return reply.status(404).send({ error: 'not_found' });
      }

      // Check membership
      const member = app.db
        .select({ role: members.role })
        .from(members)
        .where(
          and(
            eq(members.groupId, grp.id),
            eq(members.userId, webUser.id),
            isNull(members.removedAt),
          ),
        )
        .get();

      if (!member) {
        return reply.status(404).send({ error: 'not_found' });
      }

      if (!can(member.role as Role, 'invite')) {
        return reply.status(403).send({ error: 'forbidden' });
      }

      // Fetch active invites with creator names in a single JOIN query
      const rows = app.db
        .select({
          id: invites.id,
          codeHint: invites.codeHint,
          role: invites.role,
          expiresAt: invites.expiresAt,
          maxUses: invites.maxUses,
          uses: invites.uses,
          createdAt: invites.createdAt,
          creatorName: users.name,
        })
        .from(invites)
        .innerJoin(users, eq(invites.createdBy, users.id))
        .where(and(eq(invites.groupId, grp.id), isNull(invites.revokedAt)))
        .all();

      const result = rows.map((row) => {
        const hint = row.codeHint ? `${row.codeHint}-••••` : '••••-••••';
        return {
          id: row.id,
          codeDisplay: hint,
          role: row.role,
          expiresAt: row.expiresAt,
          maxUses: row.maxUses,
          uses: row.uses,
          createdBy: row.creatorName,
          createdAt: row.createdAt,
        };
      });

      return reply.status(200).send(result);
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/web/groups/:slug/invites
  // -------------------------------------------------------------------------
  app.post<{
    Params: { slug: string };
    Body: { role?: unknown; expires?: unknown; maxUses?: unknown };
  }>(
    '/api/web/groups/:slug/invites',
    { preHandler: [csrfHook, requireWebSession] },
    async (request, reply) => {
      const webUser = request.webUser as WebUser;
      const { slug } = request.params;

      const grp = app.db.select({ id: groups.id }).from(groups).where(eq(groups.slug, slug)).get();

      if (!grp) {
        return reply.status(404).send({ error: 'not_found' });
      }

      const member = app.db
        .select({ role: members.role })
        .from(members)
        .where(
          and(
            eq(members.groupId, grp.id),
            eq(members.userId, webUser.id),
            isNull(members.removedAt),
          ),
        )
        .get();

      if (!member) {
        return reply.status(404).send({ error: 'not_found' });
      }

      if (!can(member.role as Role, 'invite')) {
        return reply.status(403).send({ error: 'forbidden' });
      }

      const body = request.body as { role?: unknown; expires?: unknown; maxUses?: unknown };
      const roleVal = body.role;
      const expiresVal = body.expires ?? 'never';
      const maxUsesVal = body.maxUses;

      if (
        typeof roleVal !== 'string' ||
        !INVITE_ROLES.includes(roleVal as (typeof INVITE_ROLES)[number])
      ) {
        return reply.status(400).send({ error: 'bad_request', message: 'invalid role' });
      }

      if (roleVal === 'owner') {
        return reply.status(400).send({ error: 'bad_request', message: 'invalid role' });
      }

      if (expiresVal !== '24h' && expiresVal !== '7d' && expiresVal !== 'never') {
        return reply.status(400).send({ error: 'bad_request', message: 'invalid expires' });
      }

      const maxUses = typeof maxUsesVal === 'number' && maxUsesVal > 0 ? maxUsesVal : null;

      const code = generateInviteCode();
      const codeHash = hashInviteCode(code);
      const codeHint = code.split('-')[0] ?? null;
      const expiresAt = parseExpiry(expiresVal as '24h' | '7d' | 'never');
      const now = new Date().toISOString();

      app.db
        .insert(invites)
        .values({
          id: newId(),
          groupId: grp.id,
          codeHash,
          codeHint,
          role: roleVal,
          createdBy: webUser.id,
          expiresAt: expiresAt ? expiresAt.toISOString() : null,
          maxUses,
          uses: 0,
          createdAt: now,
        })
        .run();

      // Code returned once in plain text
      return reply.status(200).send({ code });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/web/groups/:slug/invites/:id/revoke
  // -------------------------------------------------------------------------
  app.post<{ Params: { slug: string; id: string } }>(
    '/api/web/groups/:slug/invites/:id/revoke',
    { preHandler: [csrfHook, requireWebSession] },
    async (request, reply) => {
      const webUser = request.webUser as WebUser;
      const { slug, id } = request.params;

      const grp = app.db.select({ id: groups.id }).from(groups).where(eq(groups.slug, slug)).get();

      if (!grp) {
        return reply.status(404).send({ error: 'not_found' });
      }

      const member = app.db
        .select({ role: members.role })
        .from(members)
        .where(
          and(
            eq(members.groupId, grp.id),
            eq(members.userId, webUser.id),
            isNull(members.removedAt),
          ),
        )
        .get();

      if (!member) {
        return reply.status(404).send({ error: 'not_found' });
      }

      if (!can(member.role as Role, 'revoke')) {
        return reply.status(403).send({ error: 'forbidden' });
      }

      const now = new Date().toISOString();
      const result = app.db
        .update(invites)
        .set({ revokedAt: now })
        .where(and(eq(invites.id, id), eq(invites.groupId, grp.id), isNull(invites.revokedAt)))
        .run();

      if (result.changes === 0) {
        return reply.status(404).send({ error: 'not_found' });
      }

      return reply.status(200).send({ ok: true });
    },
  );
}
