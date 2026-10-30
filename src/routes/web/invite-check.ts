import { joinRequestSchema } from '@chamba/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { hashInviteCode } from '../../auth/tokens.js';
import { groups, invites, users } from '../../db/schema.js';
import { inviteCodeRateLimit } from '../invite-rate-limit.js';

export async function webInviteCheckRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /api/web/invites/:code/check
  // -------------------------------------------------------------------------
  app.get<{ Params: { code: string } }>(
    '/api/web/invites/:code/check',
    {
      preHandler: [inviteCodeRateLimit],
    },
    async (request, reply) => {
      const rawCode = request.params.code;

      // Normalize: trim and uppercase
      const normalizedCode = rawCode.trim().toUpperCase();

      // Validate format before DB (joinRequestSchema normalizes and validates the code field)
      const parsed = joinRequestSchema.safeParse({
        code: normalizedCode,
        name: 'x',
        email: 'x@x.com',
      });
      if (!parsed.success) {
        // Invalid format — respond without touching DB
        return reply.status(200).send({ valid: false });
      }

      const codeHash = hashInviteCode(normalizedCode);
      const now = new Date().toISOString();

      const invite = app.db
        .select({
          id: invites.id,
          groupId: invites.groupId,
          role: invites.role,
          expiresAt: invites.expiresAt,
          maxUses: invites.maxUses,
          uses: invites.uses,
          revokedAt: invites.revokedAt,
          createdBy: invites.createdBy,
        })
        .from(invites)
        .where(eq(invites.codeHash, codeHash))
        .get();

      if (
        !invite ||
        invite.revokedAt !== null ||
        (invite.expiresAt !== null && invite.expiresAt < now) ||
        (invite.maxUses !== null && invite.uses >= invite.maxUses)
      ) {
        return reply.status(200).send({ valid: false });
      }

      const grp = app.db
        .select({ id: groups.id, name: groups.name, slug: groups.slug })
        .from(groups)
        .where(eq(groups.id, invite.groupId))
        .get();

      if (!grp) {
        return reply.status(200).send({ valid: false });
      }

      // Get inviter's first name
      const inviter = app.db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, invite.createdBy))
        .get();

      const inviterFirstName = inviter?.name
        ? (inviter.name.split(' ')[0] ?? inviter.name)
        : 'alguien';

      // Format expires label
      let expiresLabel = 'nunca';
      if (invite.expiresAt) {
        const exp = new Date(invite.expiresAt);
        expiresLabel = exp.toLocaleDateString('es', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        });
      }

      return reply.status(200).send({
        valid: true,
        group: { name: grp.name, slug: grp.slug },
        role: invite.role,
        inviter: inviterFirstName,
        expiresLabel,
      });
    },
  );
}
