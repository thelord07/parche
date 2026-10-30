import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { csrfHook } from '../../auth/csrf.js';
import { generateMagicToken, generateSessionSecret, hashToken } from '../../auth/tokens.js';
import {
  COOKIE_NAME,
  requireWebSession,
  SESSION_MAX_AGE,
  type WebUser,
} from '../../auth/web-session.js';
import type { Config } from '../../config.js';
import { groups, magicLinks, members, sessions, users } from '../../db/schema.js';
import { newId } from '../../ids.js';
import type { Mailer } from '../../mail/mailer.js';

// ---------------------------------------------------------------------------
// In-memory per-email rate limiter (sliding window, process-local)
// Two-generation design keeps memory bounded without direct entry removal.
// ---------------------------------------------------------------------------

const EMAIL_RATE_MAX = 5;
const EMAIL_RATE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

let emailCurrentGen = new Map<string, number[]>();
let emailPrevGen = new Map<string, number[]>();
let emailGenStart = 0; // lazily set on first call

function rotateEmailGen(now: number): void {
  if (emailGenStart === 0) {
    emailGenStart = now;
    return;
  }
  if (now - emailGenStart >= EMAIL_RATE_WINDOW_MS) {
    emailPrevGen = emailCurrentGen;
    emailCurrentGen = new Map<string, number[]>();
    emailGenStart = now;
  }
}

function emailRateLimitCheck(emailHash: string, nowMs?: number): boolean {
  const now = nowMs ?? Date.now();
  rotateEmailGen(now);

  const cutoff = now - EMAIL_RATE_WINDOW_MS;
  const cur = emailCurrentGen.get(emailHash) ?? [];
  const prev = emailPrevGen.get(emailHash) ?? [];
  const recent = [...cur, ...prev].filter((t) => t > cutoff);

  recent.push(now);
  // Do not store if empty after push would be wrong — we always have the new timestamp
  emailCurrentGen.set(
    emailHash,
    recent.filter((t) => t > cutoff),
  );
  return recent.length <= EMAIL_RATE_MAX;
}

/** Reset all email counters. For use in tests only. */
export function resetEmailCounters(): void {
  emailCurrentGen = new Map<string, number[]>();
  emailPrevGen = new Map<string, number[]>();
  emailGenStart = 0;
}

/** Number of distinct email hashes tracked. For use in tests only. */
export function emailCountersSize(): number {
  const keys = new Set<string>([...emailCurrentGen.keys(), ...emailPrevGen.keys()]);
  return keys.size;
}

// ---------------------------------------------------------------------------
// AUTH ROUTES
// ---------------------------------------------------------------------------

export interface AuthRouteOptions {
  mailer: Mailer;
  config: Config;
  /**
   * In tests, callers can await the background work promise returned here.
   * Production: fire-and-forget.
   */
  onBackgroundWork?: (p: Promise<void>) => void;
}

export async function webAuthRoutes(app: FastifyInstance, opts: AuthRouteOptions): Promise<void> {
  const { mailer, config } = opts;

  // -------------------------------------------------------------------------
  // POST /api/web/auth/request
  // -------------------------------------------------------------------------
  // IP-level rate limit constants — not an env var, intentional
  const IP_RATE_LIMIT_MAX = 10;
  const IP_RATE_LIMIT_WINDOW = '15 minutes';

  app.post<{ Body: { email?: unknown } }>(
    '/api/web/auth/request',
    {
      config: {
        rateLimit: {
          max: IP_RATE_LIMIT_MAX,
          timeWindow: IP_RATE_LIMIT_WINDOW,
          keyGenerator: (req) => req.ip,
        },
      },
      preHandler: [csrfHook],
    },
    async (request, reply) => {
      const rawEmail =
        typeof request.body === 'object' && request.body !== null && 'email' in request.body
          ? (request.body as { email: unknown }).email
          : undefined;

      if (typeof rawEmail !== 'string' || rawEmail.trim() === '') {
        // Still respond 200 — no info leakage
        return reply.status(200).send({ ok: true });
      }

      const email = rawEmail.trim().toLowerCase();

      // Basic email format check
      if (!/.+@.+\..+/.test(email)) {
        return reply.status(200).send({ ok: true });
      }

      // Count in both branches for the per-email rate limit
      const emailHash = createHash('sha256').update(email).digest('hex');
      const withinLimit = emailRateLimitCheck(emailHash);

      // Respond 200 immediately — work is fire-and-forget
      await reply.status(200).send({ ok: true });

      // Background work after reply
      const work = (async () => {
        if (!withinLimit) return;

        // Check eligibility: existing user or creator
        const existingUser = app.db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, email))
          .get();

        const isCreator = config.creators.includes(email);

        if (!existingUser && !isCreator) {
          // Not eligible — no token, no mail
          return;
        }

        // Generate token and store hash
        const token = generateMagicToken();
        const tokenHash = hashToken(token);
        const now = new Date().toISOString();
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        const ip = request.ip ?? null;

        app.db
          .insert(magicLinks)
          .values({
            id: newId(),
            email,
            tokenHash,
            createdAt: now,
            expiresAt,
            ip,
          })
          .run();

        // Send magic link — errors are logged but no token/URL is logged
        try {
          await mailer.sendMagicLink({ to: email, token });
        } catch (err) {
          // Log error without token or URL
          app.log.error({ msg: 'Failed to send magic link email', err: String(err) });
        }
      })();

      if (opts.onBackgroundWork) {
        opts.onBackgroundWork(work);
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/web/auth/verify
  // -------------------------------------------------------------------------
  app.post<{ Body: { token?: unknown } }>(
    '/api/web/auth/verify',
    {
      preHandler: [csrfHook],
    },
    async (request, reply) => {
      const rawToken =
        typeof request.body === 'object' && request.body !== null && 'token' in request.body
          ? (request.body as { token: unknown }).token
          : undefined;

      if (typeof rawToken !== 'string' || !rawToken) {
        return reply.status(410).send({ error: 'link' });
      }

      const tokenHash = hashToken(rawToken);
      const now = new Date().toISOString();

      const link = app.db
        .select()
        .from(magicLinks)
        .where(eq(magicLinks.tokenHash, tokenHash))
        .get();

      if (!link || link.usedAt !== null || link.expiresAt < now) {
        return reply.status(410).send({ error: 'link' });
      }

      // Mark used (UPDATE, never delete)
      app.db.update(magicLinks).set({ usedAt: now }).where(eq(magicLinks.id, link.id)).run();

      const email = link.email;

      // Find or create user
      let userId: string;
      let userName: string;

      const existingUser = app.db
        .select({ id: users.id, name: users.name, emailVerifiedAt: users.emailVerifiedAt })
        .from(users)
        .where(eq(users.email, email))
        .get();

      if (existingUser) {
        userId = existingUser.id;
        userName = existingUser.name;
        // Set email_verified_at if not set
        if (!existingUser.emailVerifiedAt) {
          app.db.update(users).set({ emailVerifiedAt: now }).where(eq(users.id, userId)).run();
        }
      } else {
        // Creator creating their account for the first time
        userId = newId();
        userName = email.split('@')[0] ?? email;
        app.db
          .insert(users)
          .values({
            id: userId,
            name: userName,
            email,
            emailVerifiedAt: now,
            createdAt: now,
          })
          .run();
      }

      // Rotate existing session if any
      const prevSecret = request.cookies[COOKIE_NAME];
      if (prevSecret) {
        const prevHash = hashToken(prevSecret);
        app.db
          .update(sessions)
          .set({ revokedAt: now })
          .where(and(eq(sessions.tokenHash, prevHash), isNull(sessions.revokedAt)))
          .run();
      }

      // Create new session
      const secret = generateSessionSecret();
      const sessionHash = hashToken(secret);
      const expiresAt = new Date(Date.now() + SESSION_MAX_AGE * 1000).toISOString();

      app.db
        .insert(sessions)
        .values({
          id: newId(),
          userId,
          tokenHash: sessionHash,
          createdAt: now,
          expiresAt,
        })
        .run();

      // Set cookie
      const secure = config.isProduction;
      reply.setCookie(COOKIE_NAME, secret, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_MAX_AGE,
        secure,
      });

      return reply.status(200).send({ ok: true });
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/web/me
  // -------------------------------------------------------------------------
  app.get('/api/web/me', { preHandler: [requireWebSession] }, async (request, reply) => {
    const webUser = request.webUser as WebUser;

    const memberRows = app.db
      .select({
        slug: groups.slug,
        name: groups.name,
        role: members.role,
      })
      .from(members)
      .innerJoin(groups, eq(members.groupId, groups.id))
      .where(and(eq(members.userId, webUser.id), isNull(members.removedAt)))
      .all();

    return reply.status(200).send({
      user: { id: webUser.id, name: webUser.name, email: webUser.email },
      groups: memberRows,
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/web/auth/logout
  // -------------------------------------------------------------------------
  app.post(
    '/api/web/auth/logout',
    { preHandler: [csrfHook, requireWebSession] },
    async (request, reply) => {
      const secret = request.cookies[COOKIE_NAME];
      if (secret) {
        const tokenHash = hashToken(secret);
        const now = new Date().toISOString();
        app.db
          .update(sessions)
          .set({ revokedAt: now })
          .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)))
          .run();
      }

      reply.setCookie(COOKIE_NAME, '', {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 0,
        secure: config.isProduction,
      });

      return reply.status(200).send({ ok: true });
    },
  );
}
