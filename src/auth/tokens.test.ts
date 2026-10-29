import { describe, expect, it } from 'vitest';
import {
  generateDeviceToken,
  generateInviteCode,
  hashInviteCode,
  hashToken,
  parseExpiry,
} from './tokens.js';

const INVITE_CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

describe('generateDeviceToken', () => {
  it('starts with pch_ prefix', () => {
    const token = generateDeviceToken();
    expect(token).toMatch(/^pch_/);
  });

  it('has a base64url body of 32 bytes (43 chars after pch_)', () => {
    const token = generateDeviceToken();
    // 32 bytes base64url → 43 chars (no padding)
    const body = token.slice(4);
    expect(body).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('produces distinct tokens each call', () => {
    const a = generateDeviceToken();
    const b = generateDeviceToken();
    expect(a).not.toBe(b);
  });
});

describe('hashToken', () => {
  it('returns a 64-char lowercase hex SHA-256', () => {
    const hash = hashToken(generateDeviceToken());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same token gives same hash', () => {
    const token = generateDeviceToken();
    expect(hashToken(token)).toBe(hashToken(token));
  });

  it('different tokens produce different hashes', () => {
    const a = generateDeviceToken();
    const b = generateDeviceToken();
    expect(hashToken(a)).not.toBe(hashToken(b));
  });
});

describe('generateInviteCode', () => {
  it('matches the XXXX-XXXX format', () => {
    const code = generateInviteCode();
    expect(code).toMatch(INVITE_CODE_RE);
  });

  it('produces distinct codes each call', () => {
    const a = generateInviteCode();
    const b = generateInviteCode();
    expect(a).not.toBe(b);
  });

  it('produces 50 distinct codes in a row (statistical uniqueness)', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateInviteCode()));
    expect(codes.size).toBe(50);
  });
});

describe('hashInviteCode', () => {
  it('returns a 64-char lowercase hex SHA-256', () => {
    const hash = hashInviteCode(generateInviteCode());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(hashInviteCode('ABCD-1234')).toBe(hashInviteCode('abcd-1234'));
    expect(hashInviteCode('ABCD-1234')).toBe(hashInviteCode('  ABCD-1234  '));
  });

  it('is deterministic', () => {
    const code = generateInviteCode();
    expect(hashInviteCode(code)).toBe(hashInviteCode(code));
  });
});

describe('parseExpiry', () => {
  it("'24h' returns a Date ~24 h from now", () => {
    const before = Date.now();
    const result = parseExpiry('24h');
    expect(result).toBeInstanceOf(Date);
    const diff = (result as Date).getTime() - before;
    // Allow 1 s tolerance
    expect(diff).toBeGreaterThanOrEqual(24 * 3600 * 1000 - 1000);
    expect(diff).toBeLessThanOrEqual(24 * 3600 * 1000 + 1000);
  });

  it("'7d' returns a Date ~7 days from now", () => {
    const before = Date.now();
    const result = parseExpiry('7d');
    expect(result).toBeInstanceOf(Date);
    const diff = (result as Date).getTime() - before;
    expect(diff).toBeGreaterThanOrEqual(7 * 24 * 3600 * 1000 - 1000);
    expect(diff).toBeLessThanOrEqual(7 * 24 * 3600 * 1000 + 1000);
  });

  it("'never' returns null", () => {
    expect(parseExpiry('never')).toBeNull();
  });
});
