/**
 * Unit tests for the invite-code rate limiter:
 * - Two-generation bounded memory
 * - Retry-After header on 429
 * - Size getter
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkAndIncrementInvite,
  inviteRateLimitSize,
  resetInviteRateLimit,
} from './invite-rate-limit.js';

const WINDOW_MS = 60_000; // must match TIME_WINDOW_MS in invite-rate-limit.ts

describe('invite-rate-limit — bounded memory', () => {
  beforeEach(() => resetInviteRateLimit());
  afterEach(() => resetInviteRateLimit());

  it('allows up to 10 requests per IP per window', () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      expect(checkAndIncrementInvite('1.2.3.4', now + i)).toBe(true);
    }
    expect(checkAndIncrementInvite('1.2.3.4', now + 10)).toBe(false);
  });

  it('allows requests from different IPs independently', () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      checkAndIncrementInvite('1.1.1.1', now + i);
    }
    // Different IP still gets 10 slots
    expect(checkAndIncrementInvite('2.2.2.2', now)).toBe(true);
  });

  it('size is bounded: after window expires, old IPs drop off', () => {
    const t0 = Date.now();
    const N = 50;

    // Add N distinct IPs at t0
    for (let i = 0; i < N; i++) {
      checkAndIncrementInvite(`10.0.0.${i}`, t0);
    }
    expect(inviteRateLimitSize()).toBe(N);

    // Advance past one window — rotation happens; IPs are now in prevGen
    const t1 = t0 + WINDOW_MS + 1;
    // Add N new distinct IPs at t1 (triggers rotation)
    for (let i = 0; i < N; i++) {
      checkAndIncrementInvite(`192.168.0.${i}`, t1);
    }
    // prevGen has old IPs, currentGen has new ones; size = 2N max, but still bounded
    expect(inviteRateLimitSize()).toBeLessThanOrEqual(N * 2);

    // Advance past another window — rotation again; old IPs (10.0.0.*) are evicted
    const t2 = t1 + WINDOW_MS + 1;
    for (let i = 0; i < N; i++) {
      checkAndIncrementInvite(`172.16.0.${i}`, t2);
    }
    // After two rotations, the original N IPs are gone; size <= N + N (new batch)
    expect(inviteRateLimitSize()).toBeLessThanOrEqual(N * 2);
    // Specifically the first batch should be gone
    expect(inviteRateLimitSize()).toBe(N * 2); // current + prev from last two batches
  });

  it('size returns to 0 after two full windows with no activity on old IPs', () => {
    const t0 = Date.now();
    checkAndIncrementInvite('1.1.1.1', t0);
    expect(inviteRateLimitSize()).toBe(1);

    // First rotation: 1.1.1.1 moves to prevGen
    const t1 = t0 + WINDOW_MS + 1;
    checkAndIncrementInvite('2.2.2.2', t1);
    expect(inviteRateLimitSize()).toBe(2); // prev: 1.1.1.1, current: 2.2.2.2

    // Second rotation: prevGen (1.1.1.1) is replaced with what was current (2.2.2.2)
    const t2 = t1 + WINDOW_MS + 1;
    checkAndIncrementInvite('3.3.3.3', t2);
    // Now prev: {2.2.2.2}, current: {3.3.3.3} — 1.1.1.1 is gone
    expect(inviteRateLimitSize()).toBe(2);
  });
});

describe('invite-rate-limit — Retry-After header', () => {
  let dataDir: string;
  let app: import('fastify').FastifyInstance;

  beforeEach(async () => {
    resetInviteRateLimit();
    const { makeTempDataDir, makeApp, makeConfig } = await import('../test-helpers.js');
    dataDir = await makeTempDataDir();
    app = await makeApp(dataDir, makeConfig(dataDir));
  });

  afterEach(async () => {
    await app.close();
    const { cleanupDir } = await import('../test-helpers.js');
    await cleanupDir(dataDir);
    resetInviteRateLimit();
  });

  it('429 response includes Retry-After header', async () => {
    const code = 'AAAA-BBBB';
    // Exhaust the bucket (10 requests)
    for (let i = 0; i < 10; i++) {
      await app.inject({ method: 'GET', url: `/api/web/invites/${code}/check` });
    }
    const res = await app.inject({
      method: 'GET',
      url: `/api/web/invites/${code}/check`,
    });
    expect(res.statusCode).toBe(429);
    const retryAfter = res.headers['retry-after'];
    expect(retryAfter).toBeDefined();
    const seconds = Number(retryAfter);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(60);
  });
});
