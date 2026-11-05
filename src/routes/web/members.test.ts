/**
 * B-T2 / B-T3 / B-T4 / B-T5: Tests de endpoints de miembros y dispositivos.
 *
 * Cubre:
 *  - Forma de GET /members (con kind, devices, lastSyncAt)
 *  - Matriz de permisos a nivel HTTP (403/404/409/400/200)
 *  - CSRF ausente → 403
 *  - No-miembro/cross-group/removido → 404
 *  - Auditoría: log info contiene {actor,action,target}, no contiene tokens
 *  - B-T3: dispositivo revocado → 401 en /api/g/:slug/changes
 *  - B-T4: miembro removido (no aparece en /me, 404 en rutas web, dispositivos revocados, cambios intactos)
 *  - B-T5: nunca sin owner (dos intentos sucesivos)
 *  - Regla de email: owner/admin ven emails ajenos; editor/reader no
 */

import { PassThrough } from 'node:stream';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDevice } from '../../admin/commands.js';
import { changes, devices, members } from '../../db/schema.js';
import { buildServer } from '../../server.js';
import {
  cleanupDir,
  makeConfig,
  makeTempDataDir,
  seedGroupWithDevice,
  seedMember,
  seedWebSession,
  seedWebUser,
} from '../../test-helpers.js';

const CSRF = {
  'content-type': 'application/json',
  'x-parche-csrf': '1',
};

// ---------------------------------------------------------------------------
// Setup compartido
// ---------------------------------------------------------------------------

async function setup() {
  const dataDir = await makeTempDataDir();
  const app = await buildServer(
    { ...makeConfig(dataDir), logLevel: 'silent' },
    { transport: { sendMail: async () => ({ messageId: 'test' }) } as never },
  );
  await app.ready();

  // Grupo principal con owner via CLI (tiene dispositivo)
  const ownerCli = await seedGroupWithDevice(app, {
    slug: 'slug-test',
    ownerEmail: 'owner@test.com',
    ownerName: 'Owner',
  });

  // Crear usuarios web con diferentes roles
  const ownerUser = seedWebUser(app, { email: 'owner@test.com', name: 'Owner' });
  const adminUser = seedWebUser(app, { email: 'admin@test.com', name: 'Admin' });
  const editorUser = seedWebUser(app, { email: 'editor@test.com', name: 'Editor' });
  const readerUser = seedWebUser(app, { email: 'reader@test.com', name: 'Reader' });

  // Asegurar que owner@test.com tenga membresía owner (ya fue creado por seedGroupWithDevice)
  // Agregar los otros miembros
  seedMember(app, { groupSlug: 'slug-test', userId: adminUser.userId, role: 'admin' });
  seedMember(app, { groupSlug: 'slug-test', userId: editorUser.userId, role: 'editor' });
  seedMember(app, { groupSlug: 'slug-test', userId: readerUser.userId, role: 'reader' });

  // Sesiones web
  const ownerSession = seedWebSession(app, ownerUser.userId);
  const adminSession = seedWebSession(app, adminUser.userId);
  const editorSession = seedWebSession(app, editorUser.userId);
  const readerSession = seedWebSession(app, readerUser.userId);

  // Grupo de otro usuario (para tests cross-group)
  const otherGroup = await seedGroupWithDevice(app, { slug: 'other-group' });
  const outsiderUser = seedWebUser(app, { email: 'outsider@test.com', name: 'Outsider' });
  const outsiderSession = seedWebSession(app, outsiderUser.userId);

  return {
    dataDir,
    app,
    ownerCli,
    ownerUser,
    adminUser,
    editorUser,
    readerUser,
    ownerSession,
    adminSession,
    editorSession,
    readerSession,
    otherGroup,
    outsiderUser,
    outsiderSession,
    cleanup: async () => {
      await app.close();
      await cleanupDir(dataDir);
    },
  };
}

// ---------------------------------------------------------------------------
// GET /members — forma de respuesta y visibilidad de email
// ---------------------------------------------------------------------------

describe('GET /api/web/g/:slug/members', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('200: forma correcta con kind:device y lastSyncAt', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/slug-test/members',
      cookies: { parche_session: ctx.ownerSession },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{
      user: { id: string; name: string; email?: string };
      role: string;
      joinedAt: string;
      isYou: boolean;
      lastSyncAt: string | null;
      devices: Array<{
        id: string;
        label: string;
        kind: string;
        lastSeenAt: string | null;
        createdAt: string;
        revokedAt: string | null;
      }>;
    }>;
    expect(Array.isArray(body)).toBe(true);
    // owner aparece primero
    expect(body[0]?.role).toBe('owner');
    // Dispositivos tienen kind:'device'
    for (const m of body) {
      for (const d of m.devices) {
        expect(d.kind).toBe('device');
        expect(d.id).toBeDefined();
        expect(d.label).toBeDefined();
      }
    }
  });

  it('200: miembro sin dispositivos tiene devices:[] y lastSyncAt:null', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/slug-test/members',
      cookies: { parche_session: ctx.ownerSession },
    });
    const body = res.json() as Array<{
      user: { name: string };
      devices: unknown[];
      lastSyncAt: unknown;
    }>;
    // Editor y reader no tienen dispositivos en este setup
    const editorRow = body.find((m) => m.user.name === 'Editor');
    expect(editorRow?.devices).toEqual([]);
    expect(editorRow?.lastSyncAt).toBeNull();
  });

  it('200: isYou = true para el viewer', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/slug-test/members',
      cookies: { parche_session: ctx.editorSession },
    });
    const body = res.json() as Array<{ user: { name: string }; isYou: boolean }>;
    const editorRow = body.find((m) => m.user.name === 'Editor');
    expect(editorRow?.isYou).toBe(true);
    // Los demás no son "tú"
    const ownerRow = body.find((m) => m.user.name === 'Owner');
    expect(ownerRow?.isYou).toBe(false);
  });

  it('401 sin sesión', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/web/g/slug-test/members' });
    expect(res.statusCode).toBe(401);
  });

  it('404 para no-miembro del grupo', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/slug-test/members',
      cookies: { parche_session: ctx.outsiderSession },
    });
    expect(res.statusCode).toBe(404);
  });

  // ─── Regla de email ─────────────────────────────────────────────────────────

  it('owner ve emails ajenos', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/slug-test/members',
      cookies: { parche_session: ctx.ownerSession },
    });
    const body = res.json() as Array<{ user: { email?: string; name: string } }>;
    const adminRow = body.find((m) => m.user.name === 'Admin');
    expect(adminRow?.user.email).toBe('admin@test.com');
  });

  it('admin ve emails ajenos', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/slug-test/members',
      cookies: { parche_session: ctx.adminSession },
    });
    const body = res.json() as Array<{ user: { email?: string; name: string } }>;
    const editorRow = body.find((m) => m.user.name === 'Editor');
    expect(editorRow?.user.email).toBe('editor@test.com');
  });

  it('editor NO ve emails ajenos pero sí el propio', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/slug-test/members',
      cookies: { parche_session: ctx.editorSession },
    });
    const body = res.json() as Array<{ user: { email?: string; name: string }; isYou: boolean }>;
    const rawBody = res.body;

    // El email del owner NO debe aparecer en el body crudo para editor
    expect(rawBody).not.toContain('owner@test.com');
    expect(rawBody).not.toContain('admin@test.com');
    expect(rawBody).not.toContain('reader@test.com');

    // El propio email sí aparece
    const myRow = body.find((m) => m.isYou);
    expect(myRow?.user.email).toBe('editor@test.com');
  });

  it('reader NO ve emails ajenos pero sí el propio', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/slug-test/members',
      cookies: { parche_session: ctx.readerSession },
    });
    const rawBody = res.body;
    expect(rawBody).not.toContain('owner@test.com');
    expect(rawBody).not.toContain('admin@test.com');
    expect(rawBody).not.toContain('editor@test.com');
    // Propio email sí
    expect(rawBody).toContain('reader@test.com');
  });
});

// ---------------------------------------------------------------------------
// POST /members/:userId/role
// ---------------------------------------------------------------------------

describe('POST /api/web/g/:slug/members/:userId/role', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('403 sin CSRF', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/members/${ctx.editorUser.userId}/role`,
      headers: { 'content-type': 'application/json' },
      cookies: { parche_session: ctx.ownerSession },
      payload: { role: 'reader' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('csrf');
  });

  it('200: owner cambia editor a reader', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/members/${ctx.editorUser.userId}/role`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.ownerSession },
      payload: { role: 'reader' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('200: admin cambia editor a reader', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/members/${ctx.editorUser.userId}/role`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.adminSession },
      payload: { role: 'reader' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('403: editor no puede cambiar roles', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/members/${ctx.readerUser.userId}/role`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.editorSession },
      payload: { role: 'editor' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('403: reader no puede cambiar roles', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/members/${ctx.editorUser.userId}/role`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.readerSession },
      payload: { role: 'reader' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('403: admin no puede tocar al owner', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/members/${ctx.ownerUser.userId}/role`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.adminSession },
      payload: { role: 'editor' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('400: destino owner → invalid_role', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/members/${ctx.editorUser.userId}/role`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.ownerSession },
      payload: { role: 'owner' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_role');
  });

  it('400: destino desconocido → invalid_role', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/members/${ctx.editorUser.userId}/role`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.ownerSession },
      payload: { role: 'superadmin' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('409: owner intenta bajarse a sí mismo (único owner) → last_owner', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/members/${ctx.ownerUser.userId}/role`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.ownerSession },
      payload: { role: 'admin' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('last_owner');
  });

  it('404 para userId que no es miembro del grupo', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/members/${ctx.outsiderUser.userId}/role`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.ownerSession },
      payload: { role: 'editor' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('404 para no-miembro del grupo (outsider)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/members/${ctx.editorUser.userId}/role`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.outsiderSession },
      payload: { role: 'reader' },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /members/:userId/remove
// ---------------------------------------------------------------------------

describe('POST /api/web/g/:slug/members/:userId/remove', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('403 sin CSRF', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/members/${ctx.editorUser.userId}/remove`,
      headers: { 'content-type': 'application/json' },
      cookies: { parche_session: ctx.ownerSession },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('csrf');
  });

  it('200: owner quita a editor', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/members/${ctx.editorUser.userId}/remove`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.ownerSession },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });

  it('200: admin quita a reader', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/members/${ctx.readerUser.userId}/remove`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.adminSession },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });

  it('403: editor no puede quitar miembros', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/members/${ctx.readerUser.userId}/remove`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.editorSession },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('403: admin no puede quitar al owner', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/members/${ctx.ownerUser.userId}/remove`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.adminSession },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('409: owner no puede quitarse a sí mismo (único owner) → last_owner', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/members/${ctx.ownerUser.userId}/remove`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.ownerSession },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('last_owner');
  });

  it('404 para no-miembro del grupo (outsider)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/members/${ctx.editorUser.userId}/remove`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.outsiderSession },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('B-T4: miembro removido no aparece en GET /members', async () => {
    // Quitar editor
    await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/members/${ctx.editorUser.userId}/remove`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.ownerSession },
      payload: {},
    });

    // Verificar que no aparece en la lista
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/slug-test/members',
      cookies: { parche_session: ctx.ownerSession },
    });
    const body = res.json() as Array<{ user: { id: string } }>;
    const found = body.find((m) => m.user.id === ctx.editorUser.userId);
    expect(found).toBeUndefined();
  });

  it('B-T4: miembro removido → GET /me no muestra el grupo', async () => {
    // Dar sesión al editor primero (antes de removerlo)
    const editorSession2 = seedWebSession(ctx.app, ctx.editorUser.userId);

    // Quitar editor
    await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/members/${ctx.editorUser.userId}/remove`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.ownerSession },
      payload: {},
    });

    // /me del editor ya no incluye el grupo
    const meRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/me',
      cookies: { parche_session: editorSession2 },
    });
    if (meRes.statusCode === 200) {
      const meBody = meRes.json() as { groups?: Array<{ slug: string }> };
      const inGroup = meBody.groups?.some((g) => g.slug === 'slug-test') ?? false;
      expect(inGroup).toBe(false);
    }
  });

  it('B-T4: miembro removido → rutas web dan 404', async () => {
    const editorSession2 = seedWebSession(ctx.app, ctx.editorUser.userId);

    // Quitar editor
    await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/members/${ctx.editorUser.userId}/remove`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.ownerSession },
      payload: {},
    });

    // La ruta web del grupo ahora da 404
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/slug-test/summary',
      cookies: { parche_session: editorSession2 },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /devices/:deviceId/revoke
// ---------------------------------------------------------------------------

describe('POST /api/web/g/:slug/devices/:deviceId/revoke', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  function getEditorDeviceId(): string {
    // Crear un dispositivo para el editor
    const result = createDevice(ctx.app.db, {
      group: 'slug-test',
      email: 'editor@test.com',
      label: 'editor-device',
    });
    return result.deviceId;
  }

  it('403 sin CSRF', async () => {
    const deviceId = getEditorDeviceId();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/devices/${deviceId}/revoke`,
      headers: { 'content-type': 'application/json' },
      cookies: { parche_session: ctx.ownerSession },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('csrf');
  });

  it('200: owner revoca dispositivo de editor', async () => {
    const deviceId = getEditorDeviceId();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/devices/${deviceId}/revoke`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.ownerSession },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });

  it('200: admin revoca dispositivo de editor', async () => {
    const deviceId = getEditorDeviceId();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/devices/${deviceId}/revoke`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.adminSession },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });

  it('200: editor revoca su propio dispositivo (self-revoke)', async () => {
    const deviceId = getEditorDeviceId();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/devices/${deviceId}/revoke`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.editorSession },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });

  it('200: reader revoca su propio dispositivo (self-revoke)', async () => {
    // Crear dispositivo para reader
    const r = createDevice(ctx.app.db, {
      group: 'slug-test',
      email: 'reader@test.com',
      label: 'reader-device',
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/devices/${r.deviceId}/revoke`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.readerSession },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });

  it('403: editor NO puede revocar dispositivo de reader', async () => {
    // Crear dispositivo para reader
    const r = createDevice(ctx.app.db, {
      group: 'slug-test',
      email: 'reader@test.com',
      label: 'reader-device',
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/devices/${r.deviceId}/revoke`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.editorSession },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('403: reader NO puede revocar dispositivo ajeno', async () => {
    const deviceId = getEditorDeviceId();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/devices/${deviceId}/revoke`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.readerSession },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('200 idempotente: revocar dispositivo ya revocado', async () => {
    const deviceId = getEditorDeviceId();
    // Primera revocación
    await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/devices/${deviceId}/revoke`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.ownerSession },
      payload: {},
    });
    // Segunda revocación → 200 idempotente
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/devices/${deviceId}/revoke`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.ownerSession },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });

  it('404 para dispositivo de otro grupo (scope cross-group)', async () => {
    // Dispositivo del otro grupo no puede ser revocado por scope del slug-test
    const r = await seedGroupWithDevice(ctx.app, { slug: 'third-group' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/devices/${r.deviceId}/revoke`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.ownerSession },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('404 para no-miembro del grupo (outsider)', async () => {
    const deviceId = getEditorDeviceId();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/devices/${deviceId}/revoke`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.outsiderSession },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  // B-T3: dispositivo revocado → 401 en /api/g/:slug/changes
  it('B-T3: dispositivo revocado → Bearer da 401 en sync', async () => {
    // Crear dispositivo con token real para el editor
    const { deviceId, deviceToken } = createDevice(ctx.app.db, {
      group: 'slug-test',
      email: 'editor@test.com',
      label: 'sync-device',
    });

    // Verificar que el token funciona antes de revocar
    const beforeRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/g/slug-test/changes',
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(beforeRes.statusCode).toBe(200);

    // Revocar via web
    await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/devices/${deviceId}/revoke`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.ownerSession },
      payload: {},
    });

    // Ahora el Bearer da 401
    const afterRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/g/slug-test/changes',
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(afterRes.statusCode).toBe(401);
  });

  it('403: admin NO puede revocar dispositivo de ex-owner (último rol registrado)', async () => {
    // Crear un dispositivo para el owner original (ownerUser tiene role 'owner')
    const ownerDevice = createDevice(ctx.app.db, {
      group: 'slug-test',
      email: 'owner@test.com',
      label: 'owner-device',
    });

    // Simular que el owner fue removido del grupo (manipulación directa de DB; la API
    // impide remover al único owner por last_owner, así que se hace a nivel de test)
    const groupId = ctx.ownerCli.groupId;
    ctx.app.db
      .update(members)
      .set({ removedAt: new Date().toISOString() })
      .where(and(eq(members.groupId, groupId), eq(members.userId, ctx.ownerUser.userId)))
      .run();

    // Admin intenta revocar el dispositivo del ex-owner: debe ser 403
    // (el último rol registrado era 'owner'; admin no puede revocar dispositivos de owner)
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/devices/${ownerDevice.deviceId}/revoke`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.adminSession },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// B-T4: miembro removido — sus dispositivos quedan revocados
// ---------------------------------------------------------------------------

describe('B-T4: remove revoca dispositivos del miembro', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('dispositivos del miembro removido quedan con revokedAt', async () => {
    // Crear 2 dispositivos para editor
    const d1 = createDevice(ctx.app.db, {
      group: 'slug-test',
      email: 'editor@test.com',
      label: 'dev1',
    });
    const d2 = createDevice(ctx.app.db, {
      group: 'slug-test',
      email: 'editor@test.com',
      label: 'dev2',
    });

    // Revocar uno manualmente primero (para verificar que revokedAt existente no se pisa)
    const revokedAtBefore = new Date('2020-01-01').toISOString();
    ctx.app.db
      .update(devices)
      .set({ revokedAt: revokedAtBefore })
      .where(eq(devices.id, d1.deviceId))
      .run();

    // Quitar editor
    await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/members/${ctx.editorUser.userId}/remove`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.ownerSession },
      payload: {},
    });

    // d1 ya estaba revocado → su revokedAt se mantiene (no se sobreescribe)
    const device1 = ctx.app.db.select().from(devices).where(eq(devices.id, d1.deviceId)).get();
    expect(device1?.revokedAt).toBe(revokedAtBefore);

    // d2 ahora queda revocado
    const device2 = ctx.app.db.select().from(devices).where(eq(devices.id, d2.deviceId)).get();
    expect(device2?.revokedAt).not.toBeNull();
  });

  it('B-T4: Bearer del miembro removido da 401 en sync', async () => {
    // Crear dispositivo con token real para editor
    const { deviceToken } = createDevice(ctx.app.db, {
      group: 'slug-test',
      email: 'editor@test.com',
      label: 'sync-device',
    });

    // Verificar que funciona
    const beforeRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/g/slug-test/changes',
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(beforeRes.statusCode).toBe(200);

    // Quitar miembro (lo que revoca sus dispositivos)
    await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/members/${ctx.editorUser.userId}/remove`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.ownerSession },
      payload: {},
    });

    // Bearer ahora da 401
    const afterRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/g/slug-test/changes',
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(afterRes.statusCode).toBe(401);
  });

  it('B-T4: filas en changes permanecen tras quitar al miembro (append-only)', async () => {
    // Crear un dispositivo real para el editor
    const { deviceId } = createDevice(ctx.app.db, {
      group: 'slug-test',
      email: 'editor@test.com',
      label: 'append-device',
    });

    // groupId disponible en ctx.ownerCli.groupId (mismo grupo 'slug-test')
    const groupId = ctx.ownerCli.groupId;
    const now = new Date().toISOString();

    // Insertar una fila de cambio directamente (simula un push previo del editor)
    ctx.app.db
      .insert(changes)
      .values({
        groupId,
        seq: 9000, // seq alto para no colisionar con otros tests
        path: 'nota-del-editor-b4.md',
        hash: 'abc123deadbeef',
        userId: ctx.editorUser.userId,
        deviceId,
        at: now,
      })
      .run();

    // Contar filas de changes del editor antes de quitar
    const countBefore = ctx.app.db
      .select({ seq: changes.seq })
      .from(changes)
      .where(and(eq(changes.userId, ctx.editorUser.userId), eq(changes.groupId, groupId)))
      .all().length;
    expect(countBefore).toBe(1);

    // Quitar miembro
    await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/members/${ctx.editorUser.userId}/remove`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.ownerSession },
      payload: {},
    });

    // Las filas de changes siguen exactamente igual (append-only intacto)
    const countAfter = ctx.app.db
      .select({ seq: changes.seq })
      .from(changes)
      .where(and(eq(changes.userId, ctx.editorUser.userId), eq(changes.groupId, groupId)))
      .all().length;
    expect(countAfter).toBe(countBefore);

    // El owner puede ver la actividad del editor en GET /api/web/g/:slug/activity
    const activityRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/slug-test/activity',
      cookies: { parche_session: ctx.ownerSession },
    });
    expect(activityRes.statusCode).toBe(200);
    const body = activityRes.json() as { events: Array<{ path: string }> };
    const editorEvent = body.events.find((e) => e.path === 'nota-del-editor-b4.md');
    expect(editorEvent).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// B-T5: nunca sin owner
// ---------------------------------------------------------------------------

describe('B-T5: invariante de owner único', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('dos intentos sucesivos de demotear al único owner → ambos 409', async () => {
    // Primer intento
    const res1 = await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/members/${ctx.ownerUser.userId}/role`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.ownerSession },
      payload: { role: 'admin' },
    });
    expect(res1.statusCode).toBe(409);
    expect(res1.json().error).toBe('last_owner');

    // Segundo intento
    const res2 = await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/members/${ctx.ownerUser.userId}/role`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.ownerSession },
      payload: { role: 'editor' },
    });
    expect(res2.statusCode).toBe(409);
    expect(res2.json().error).toBe('last_owner');

    // El owner sigue siendo owner
    const member = ctx.app.db
      .select({ role: members.role })
      .from(members)
      .where(and(eq(members.userId, ctx.ownerUser.userId)))
      .get();
    expect(member?.role).toBe('owner');
  });

  it('dos intentos sucesivos de remover al único owner → ambos 409', async () => {
    const res1 = await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/members/${ctx.ownerUser.userId}/remove`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.ownerSession },
      payload: {},
    });
    expect(res1.statusCode).toBe(409);

    const res2 = await ctx.app.inject({
      method: 'POST',
      url: `/api/web/g/slug-test/members/${ctx.ownerUser.userId}/remove`,
      headers: { ...CSRF },
      cookies: { parche_session: ctx.ownerSession },
      payload: {},
    });
    expect(res2.statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Auditoría: log info contiene {actor, action, target}, no contiene tokens
// ---------------------------------------------------------------------------

describe('Auditoría de logs', () => {
  it('log info incluye actor/action/target y no contiene tokens', async () => {
    const dataDir = await makeTempDataDir();
    let logOutput = '';
    const logStream = new PassThrough();
    logStream.on('data', (chunk: Buffer) => {
      logOutput += chunk.toString();
    });

    const app = await buildServer(
      { ...makeConfig(dataDir), logLevel: 'info' },
      {
        logStream,
        transport: { sendMail: async () => ({ messageId: 'test' }) } as never,
      },
    );
    await app.ready();

    await seedGroupWithDevice(app, {
      slug: 'audit-group',
      ownerEmail: 'audit-owner@test.com',
      ownerName: 'Audit Owner',
    });
    const ownerUser = seedWebUser(app, { email: 'audit-owner@test.com' });
    const targetUser = seedWebUser(app, { email: 'audit-editor@test.com', name: 'AuditEditor' });
    seedMember(app, { groupSlug: 'audit-group', userId: targetUser.userId, role: 'editor' });
    const ownerSession = seedWebSession(app, ownerUser.userId);

    // Cambiar rol
    await app.inject({
      method: 'POST',
      url: `/api/web/g/audit-group/members/${targetUser.userId}/role`,
      headers: { ...CSRF },
      cookies: { parche_session: ownerSession },
      payload: { role: 'reader' },
    });

    // El log debe contener actor/action/target
    expect(logOutput).toContain('"action":"change_role"');
    expect(logOutput).toContain('"target":');
    expect(logOutput).toContain('"actor":');

    // No debe contener tokens de sesión ni Bearer
    expect(logOutput).not.toContain('pch_');
    expect(logOutput).not.toContain('parche_session');

    await app.close();
    await cleanupDir(dataDir);
  });
});
