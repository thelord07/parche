import type { JoinResponse } from '@chamba/core';
import { joinRequestSchema, joinResponseSchema } from '@chamba/core';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { generateDeviceToken, hashInviteCode, hashToken } from '../auth/tokens.js';
import { devices, groups, invites, members, users } from '../db/schema.js';
import { newId } from '../ids.js';

// Rate limit for the /api/join endpoint — hard-coded constant, no env override.
const JOIN_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;

// Sentinel type returned by the transaction to avoid calling reply inside it
type JoinTxResult = { kind: 'ok'; body: JoinResponse } | { kind: '404' } | { kind: '409' };

export async function joinRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/join',
    {
      config: {
        rateLimit: JOIN_RATE_LIMIT,
      },
    },
    async (request, reply) => {
      // Validate body with core schema
      const parseResult = joinRequestSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: 'bad_request', details: parseResult.error.issues });
      }
      const { code, name, email, deviceLabel } = parseResult.data;

      const now = new Date().toISOString();
      const codeHash = hashInviteCode(code);

      const result: JoinTxResult = app.db.transaction((tx) => {
        // 1. Find a valid (non-revoked, non-expired, non-exhausted) invite
        const invite = tx.select().from(invites).where(eq(invites.codeHash, codeHash)).get();

        if (
          !invite ||
          invite.revokedAt !== null ||
          (invite.expiresAt !== null && invite.expiresAt < now) ||
          (invite.maxUses !== null && invite.uses >= invite.maxUses)
        ) {
          return { kind: '404' };
        }

        const group = tx.select().from(groups).where(eq(groups.id, invite.groupId)).get();
        if (!group) {
          return { kind: '404' };
        }

        // 2. Look up user by email
        const existingUser = tx.select().from(users).where(eq(users.email, email)).get();

        let userId: string;
        let userName: string;

        if (existingUser) {
          userId = existingUser.id;
          userName = existingUser.name;

          // Check membership
          const existingMember = tx
            .select()
            .from(members)
            .where(and(eq(members.groupId, group.id), eq(members.userId, userId)))
            .get();

          if (existingMember) {
            if (existingMember.removedAt === null) {
              // Active member → 409, no device, no use consumed, no role change
              return { kind: '409' };
            }

            // Removed member → re-admit with invite's role, removed_at = NULL
            tx.update(members)
              .set({ role: invite.role, removedAt: null })
              .where(and(eq(members.groupId, group.id), eq(members.userId, userId)))
              .run();

            // Revoke any still-unrevoked old devices of this user in this group
            tx.update(devices)
              .set({ revokedAt: now })
              .where(
                and(
                  eq(devices.groupId, group.id),
                  eq(devices.userId, userId),
                  isNull(devices.revokedAt),
                ),
              )
              .run();
          } else {
            // Known user, not yet a member of this group
            tx.insert(members)
              .values({ groupId: group.id, userId, role: invite.role, createdAt: now })
              .run();
          }
        } else {
          // Brand-new user
          userId = newId();
          userName = name;
          tx.insert(users).values({ id: userId, name, email, createdAt: now }).run();
          tx.insert(members)
            .values({ groupId: group.id, userId, role: invite.role, createdAt: now })
            .run();
        }

        // Create device
        const deviceId = newId();
        const deviceToken = generateDeviceToken();
        tx.insert(devices)
          .values({
            id: deviceId,
            userId,
            groupId: group.id,
            label: deviceLabel ?? 'device',
            tokenHash: hashToken(deviceToken),
            createdAt: now,
          })
          .run();

        // Increment uses (UPDATE, never DELETE)
        tx.update(invites)
          .set({ uses: invite.uses + 1 })
          .where(eq(invites.id, invite.id))
          .run();

        const responseData = {
          group: { id: group.id, slug: group.slug, name: group.name },
          role: invite.role,
          deviceToken,
          user: { id: userId, name: userName },
          device: { id: deviceId, label: deviceLabel ?? 'device' },
        };

        return { kind: 'ok', body: joinResponseSchema.parse(responseData) };
      });

      switch (result.kind) {
        case '404':
          return reply.status(404).send({ error: 'not_found' });
        case '409':
          return reply
            .status(409)
            .send({ error: 'already_member', message: 'usa `vault login` desde esta máquina' });
        case 'ok':
          return reply.status(200).send(result.body);
      }
    },
  );
}
