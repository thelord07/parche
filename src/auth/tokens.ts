import { createHash, randomBytes } from 'node:crypto';

/**
 * Generate a device token: `pch_` + 32 random bytes as base64url.
 * The token is printed ONCE to the operator and never stored plain.
 */
export function generateDeviceToken(): string {
  return `pch_${randomBytes(32).toString('base64url')}`;
}

/**
 * Generate a magic link token: 32 random bytes as hex.
 * Never stored plain — only the sha256 hash goes to the DB.
 */
export function generateMagicToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Generate a session secret: 32 random bytes as base64url.
 * The secret is the cookie value; only its sha256 goes to the DB.
 */
export function generateSessionSecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256 hex digest of a token (or any string).
 * Only the hash is stored in the database.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Alphabet for invite codes: uppercase letters and digits, unambiguous. */
const INVITE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Generate a crypto-random invite code of the form `XXXX-XXXX`
 * using characters from [A-Z0-9].
 * Matches /^[A-Z0-9]{4}-[A-Z0-9]{4}$/ exactly.
 */
export function generateInviteCode(): string {
  function segment(len: number): string {
    const bytes = randomBytes(len * 2); // oversample to avoid modulo bias
    let result = '';
    let i = 0;
    while (result.length < len) {
      const byte = bytes[i++ % bytes.length];
      if (byte === undefined) break;
      // Reject values that would bias toward lower alphabet indices
      if (byte < 36 * Math.floor(256 / 36)) {
        result += INVITE_ALPHABET[byte % 36];
      }
    }
    // Fallback: fill remaining chars without bias concern (len is small)
    // randomBytes(1) always returns exactly 1 byte; ?? 0 satisfies TS strict indexing.
    while (result.length < len) {
      result += INVITE_ALPHABET[(randomBytes(1)[0] ?? 0) % 36];
    }
    return result;
  }
  return `${segment(4)}-${segment(4)}`;
}

/**
 * SHA-256 hex digest of the normalised invite code.
 * Normalisation: trim whitespace + uppercase (matching joinRequestSchema).
 * Only the hash is stored in the database.
 */
export function hashInviteCode(code: string): string {
  return createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
}

/**
 * Parse an expiry string into an absolute Date or null.
 * - `'24h'` → 24 hours from now
 * - `'7d'` → 7 days from now
 * - `'never'` → null (no expiry)
 */
export function parseExpiry(expiry: '24h' | '7d' | 'never'): Date | null {
  const now = Date.now();
  if (expiry === '24h') return new Date(now + 24 * 60 * 60 * 1000);
  if (expiry === '7d') return new Date(now + 7 * 24 * 60 * 60 * 1000);
  return null;
}
