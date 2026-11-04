import type { Role } from '@chamba/core';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { csrfHook } from '../../auth/csrf.js';
import { canChangeRole, canRemoveMember, canRevokeDevice } from '../../auth/member-permissions.js';
import { redactEmail } from '../../auth/member-visibility.js';
import { requireWebGroup } from '../../auth/require-web-group.js';
import type { WebUser } from '../../auth/web-session.js';
import { devices, members, users } from '../../db/schema.js';

/** Rate limit de lectura — 300 req/min por cookie, igual que group-read.ts */
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

/** Rate limit de escritura — 30 req/min por cookie para mutaciones */
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

/** Orden canónico de roles para la lista de miembros */
const ROLE_ORDER: Record<string, number> = { owner: 0, admin: 1, editor: 2, reader: 3 };

export async function webMembersRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /api/web/g/:slug/members
  // -------------------------------------------------------------------------
  app.get<{ Params: { slug: string } }>(
    '/api/web/g/:slug/members',
    { preHandler: [requireWebGroup('read')], ...RL_READ },
    async (request, reply) => {
      const { groupId } = request.webGroup!;
      const webUser = request.webUser as WebUser;
      const viewerRole = request.webGroup!.role;

      // Miembros activos con datos de usuario
      const memberRows = app.db
        .select({
          userId: members.userId,
          role: members.role,
          joinedAt: members.createdAt,
          name: users.name,
          email: users.email,
        })
        .from(members)
        .innerJoin(users, eq(members.userId, users.id))
        .where(and(eq(members.groupId, groupId), isNull(members.removedAt)))
        .all();

      // Dispositivos del grupo (todos, incluyendo revocados, agrupados por userId)
      const deviceRows = app.db
        .select({
          id: devices.id,
          userId: devices.userId,
          label: devices.label,
          lastSeenAt: devices.lastSeenAt,
          createdAt: devices.createdAt,
          revokedAt: devices.revokedAt,
        })
        .from(devices)
        .where(eq(devices.groupId, groupId))
        .all();

      // Agrupar dispositivos por userId
      const devicesByUser = new Map<
        string,
        Array<{
          id: string;
          userId: string;
          label: string;
          lastSeenAt: string | null;
          createdAt: string;
          revokedAt: string | null;
        }>
      >();
      for (const d of deviceRows) {
        const list = devicesByUser.get(d.userId) ?? [];
        list.push(d);
        devicesByUser.set(d.userId, list);
      }

      // Construir la respuesta aplicando visibilidad de email
      const result = memberRows
        .map((m) => {
          const userDevices = devicesByUser.get(m.userId) ?? [];

          // lastSyncAt = lexicographic max(lastSeenAt) de dispositivos activos (revokedAt IS NULL)
          // ISO 8601 strings are lexicographically comparable, so string > string is correct here.
          const activeDevices = userDevices.filter((d) => d.revokedAt === null);
          let lastSyncAt: string | null = null;
          for (const d of activeDevices) {
            if (d.lastSeenAt !== null && (lastSyncAt === null || d.lastSeenAt > lastSyncAt)) {
              lastSyncAt = d.lastSeenAt;
            }
          }

          const visibleEmail = redactEmail(m.email, m.userId, webUser.id, viewerRole);

          return {
            user: {
              id: m.userId,
              name: m.name,
              ...(visibleEmail !== undefined ? { email: visibleEmail } : {}),
            },
            role: m.role,
            joinedAt: m.joinedAt,
            isYou: m.userId === webUser.id,
            lastSyncAt,
            devices: userDevices.map((d) => ({
              id: d.id,
              label: d.label,
              kind: 'device' as const,
              lastSeenAt: d.lastSeenAt,
              createdAt: d.createdAt,
              revokedAt: d.revokedAt,
            })),
          };
        })
        // Ordenar: owner → admin → editor → reader, luego por nombre
        .sort((a, b) => {
          const rA = ROLE_ORDER[a.role] ?? 99;
          const rB = ROLE_ORDER[b.role] ?? 99;
          if (rA !== rB) return rA - rB;
          return a.user.name.toLowerCase().localeCompare(b.user.name.toLowerCase());
        });

      return reply.status(200).send(result);
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/web/g/:slug/members/:userId/role
  // -------------------------------------------------------------------------
  app.post<{
    Params: { slug: string; userId: string };
    Body: { role?: unknown };
  }>(
    '/api/web/g/:slug/members/:userId/role',
    { preHandler: [csrfHook, requireWebGroup('read')], ...RL_WRITE },
    async (request, reply) => {
      const { groupId } = request.webGroup!;
      const myRole = request.webGroup!.role;
      const webUser = request.webUser as WebUser;
      const myUserId = webUser.id;
      const { userId: targetUserId } = request.params;

      // Validar body
      const body = request.body as { role?: unknown };
      const destRole = body.role;
      if (typeof destRole !== 'string') {
        return reply.status(400).send({ error: 'invalid_role' });
      }

      // Resolver miembro target activo en el grupo (scope: solo este grupo)
      const targetMember = app.db
        .select({ role: members.role, userId: members.userId })
        .from(members)
        .where(
          and(
            eq(members.groupId, groupId),
            eq(members.userId, targetUserId),
            isNull(members.removedAt),
          ),
        )
        .get();

      if (!targetMember) {
        return reply.status(404).send({ error: 'not_found' });
      }

      const targetCurrentRole = targetMember.role as Role;

      // Control fino de permisos (incluye self cuando actor es el único owner)
      const result = canChangeRole(myRole, targetCurrentRole, destRole);
      if (!result.allowed) {
        if (result.reason === 'last_owner') {
          return reply.status(409).send({ error: 'last_owner' });
        }
        if (result.reason === 'invalid_role') {
          return reply.status(400).send({ error: 'invalid_role' });
        }
        return reply.status(403).send({ error: 'forbidden' });
      }

      // Actualizar rol
      app.db
        .update(members)
        .set({ role: destRole })
        .where(and(eq(members.groupId, groupId), eq(members.userId, targetUserId)))
        .run();

      // Auditoría sin tokens
      request.log.info({
        actor: myUserId,
        action: 'change_role',
        target: targetUserId,
        from: targetCurrentRole,
        to: destRole,
      });

      return reply.status(200).send({ ok: true });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/web/g/:slug/members/:userId/remove
  // -------------------------------------------------------------------------
  app.post<{ Params: { slug: string; userId: string } }>(
    '/api/web/g/:slug/members/:userId/remove',
    { preHandler: [csrfHook, requireWebGroup('read')], ...RL_WRITE },
    async (request, reply) => {
      const { groupId } = request.webGroup!;
      const myRole = request.webGroup!.role;
      const webUser = request.webUser as WebUser;
      const myUserId = webUser.id;
      const { userId: targetUserId } = request.params;

      // Resolver miembro target activo en el grupo
      const targetMember = app.db
        .select({ role: members.role })
        .from(members)
        .where(
          and(
            eq(members.groupId, groupId),
            eq(members.userId, targetUserId),
            isNull(members.removedAt),
          ),
        )
        .get();

      if (!targetMember) {
        return reply.status(404).send({ error: 'not_found' });
      }

      const targetCurrentRole = targetMember.role as Role;

      // Control fino de permisos
      const result = canRemoveMember(myRole, targetCurrentRole);
      if (!result.allowed) {
        if (result.reason === 'last_owner') {
          return reply.status(409).send({ error: 'last_owner' });
        }
        return reply.status(403).send({ error: 'forbidden' });
      }

      const now = new Date().toISOString();

      // Transacción: quitar miembro + revocar todos sus dispositivos activos
      app.db.transaction((tx) => {
        tx.update(members)
          .set({ removedAt: now })
          .where(and(eq(members.groupId, groupId), eq(members.userId, targetUserId)))
          .run();

        // Revocar solo dispositivos NO revocados previamente (preservar revokedAt existente)
        tx.update(devices)
          .set({ revokedAt: now })
          .where(
            and(
              eq(devices.groupId, groupId),
              eq(devices.userId, targetUserId),
              isNull(devices.revokedAt),
            ),
          )
          .run();
      });

      // Auditoría sin tokens
      request.log.info({
        actor: myUserId,
        action: 'remove',
        target: targetUserId,
      });

      return reply.status(200).send({ ok: true });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/web/g/:slug/devices/:deviceId/revoke
  // -------------------------------------------------------------------------
  app.post<{ Params: { slug: string; deviceId: string } }>(
    '/api/web/g/:slug/devices/:deviceId/revoke',
    { preHandler: [csrfHook, requireWebGroup('read')], ...RL_WRITE },
    async (request, reply) => {
      const { groupId } = request.webGroup!;
      const myRole = request.webGroup!.role;
      const webUser = request.webUser as WebUser;
      const myUserId = webUser.id;
      const { deviceId } = request.params;

      // Cargar dispositivo verificando que pertenece a este grupo (scope por grupo)
      const device = app.db
        .select({
          id: devices.id,
          userId: devices.userId,
          groupId: devices.groupId,
          revokedAt: devices.revokedAt,
        })
        .from(devices)
        .where(and(eq(devices.id, deviceId), eq(devices.groupId, groupId)))
        .get();

      if (!device) {
        return reply.status(404).send({ error: 'not_found' });
      }

      // Obtener el último rol registrado del dueño del dispositivo en el grupo.
      // Se omite el filtro isNull(removedAt) intencionalmente: si el dueño fue removido,
      // su último rol sigue siendo la autoridad. Caer a 'reader' permitiría que un admin
      // revocara el dispositivo de un ex-owner, lo cual está prohibido.
      const deviceOwnerMember = app.db
        .select({ role: members.role })
        .from(members)
        .where(and(eq(members.groupId, groupId), eq(members.userId, device.userId)))
        .get();

      const deviceOwnerRole = (deviceOwnerMember?.role ?? 'reader') as Role;

      // Control fino de permisos
      const result = canRevokeDevice(myUserId, myRole, device.userId, deviceOwnerRole);
      if (!result.allowed) {
        return reply.status(403).send({ error: 'forbidden' });
      }

      // Ya revocado → 200 idempotente
      if (device.revokedAt !== null) {
        return reply.status(200).send({ ok: true });
      }

      const now = new Date().toISOString();
      app.db
        .update(devices)
        .set({ revokedAt: now })
        .where(
          and(eq(devices.id, deviceId), eq(devices.groupId, groupId), isNull(devices.revokedAt)),
        )
        .run();

      // Auditoría sin tokens
      request.log.info({
        actor: myUserId,
        action: 'revoke_device',
        target: deviceId,
      });

      return reply.status(200).send({ ok: true });
    },
  );
}
