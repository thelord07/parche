/**
 * Shared rate limit bucket for invite code operations.
 * Used by both POST /api/join and GET /api/web/invites/:code/check
 * so that 10 combined requests per IP per minute is the limit.
 *
 * The bucket is module-level (per process) to share state across routes
 * without relying on @fastify/rate-limit's store (which creates per-route
 * isolated instances with global:false).
 *
 * Memory is bounded via a two-generation design: every TIME_WINDOW_MS we
 * rotate current → previous so IPs that go cold fall off within two windows
 * without ever evicting map entries directly.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

const MAX_REQUESTS = 10;
const TIME_WINDOW_MS = 60_000; // 1 minute

// Two-generation maps so stale IPs are evicted without direct removal
let inviteCurrentGen = new Map<string, number[]>();
let invitePrevGen = new Map<string, number[]>();
let inviteGenStart = 0; // lazily set on first call

function rotateInviteGen(now: number): void {
  if (inviteGenStart === 0) {
    inviteGenStart = now;
    return;
  }
  if (now - inviteGenStart >= TIME_WINDOW_MS) {
    invitePrevGen = inviteCurrentGen;
    inviteCurrentGen = new Map<string, number[]>();
    inviteGenStart = now;
  }
}

/**
 * Reset all rate limit counters. For use in tests only.
 */
export function resetInviteRateLimit(): void {
  inviteCurrentGen = new Map<string, number[]>();
  invitePrevGen = new Map<string, number[]>();
  inviteGenStart = 0;
}

/**
 * Total number of IPs tracked across both generations. For tests only.
 */
export function inviteRateLimitSize(): number {
  const keys = new Set<string>([...inviteCurrentGen.keys(), ...invitePrevGen.keys()]);
  return keys.size;
}

/**
 * Check and increment the shared invite-code rate limit for the given IP.
 * Returns true if the request should proceed, false if rate limited.
 * Accepts an optional `nowMs` for testing (defaults to Date.now()).
 */
export function checkAndIncrementInvite(ip: string, nowMs?: number): boolean {
  const now = nowMs ?? Date.now();
  rotateInviteGen(now);

  const cutoff = now - TIME_WINDOW_MS;
  const cur = inviteCurrentGen.get(ip) ?? [];
  const prev = invitePrevGen.get(ip) ?? [];
  const recent = [...cur, ...prev].filter((t) => t > cutoff);

  if (recent.length >= MAX_REQUESTS) {
    return false;
  }

  recent.push(now);
  // Only store the relevant window in current gen; skip if empty after push
  inviteCurrentGen.set(
    ip,
    recent.filter((t) => t > cutoff),
  );
  return true;
}

/**
 * Compute seconds until the window resets for rate-limited responses.
 */
function retryAfterSeconds(ip: string, now: number): number {
  const cutoff = now - TIME_WINDOW_MS;
  const cur = inviteCurrentGen.get(ip) ?? [];
  const prev = invitePrevGen.get(ip) ?? [];
  const all = [...cur, ...prev].filter((t) => t > cutoff);
  const oldest = all.length > 0 ? Math.min(...all) : now;
  return Math.ceil((oldest + TIME_WINDOW_MS - now) / 1000);
}

/**
 * Fastify preHandler that applies the shared invite-code rate limit.
 * Returns 429 with Retry-After if the rate limit is exceeded.
 */
export async function inviteCodeRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const ip = request.ip;
  const now = Date.now();
  if (!checkAndIncrementInvite(ip, now)) {
    const retryAfter = retryAfterSeconds(ip, now);
    reply.header('Retry-After', String(retryAfter));
    return reply.status(429).send({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Rate limit exceeded, retry in 1 minute',
    });
  }
}
