import { describe, expect, it } from 'vitest';
import { parseAllowHeader } from './allow-header.js';

describe('parseAllowHeader', () => {
  it('parses a valid comma-separated list', () => {
    expect(parseAllowHeader('abc123def456,112233445566')).toEqual(
      new Set(['abc123def456', '112233445566']),
    );
  });

  it('trims surrounding whitespace around entries', () => {
    expect(parseAllowHeader(' abc123def456 , 112233445566 ')).toEqual(
      new Set(['abc123def456', '112233445566']),
    );
  });

  it('silently discards invalid entries mixed with valid ones (never 400)', () => {
    expect(parseAllowHeader('abc123def456,not-hex,ZZZ,112233445566')).toEqual(
      new Set(['abc123def456', '112233445566']),
    );
  });

  it('returns an empty set for an empty string', () => {
    expect(parseAllowHeader('')).toEqual(new Set());
  });

  it('returns an empty set for undefined', () => {
    expect(parseAllowHeader(undefined)).toEqual(new Set());
  });

  it('returns an empty set when the header exceeds 2 KiB total', () => {
    const huge = Array.from({ length: 500 }, () => 'a'.repeat(12)).join(',');
    expect(parseAllowHeader(huge)).toEqual(new Set());
  });

  it('caps at 64 entries', () => {
    const entries = Array.from({ length: 100 }, (_, i) => i.toString(16).padStart(12, '0'));
    const result = parseAllowHeader(entries.join(','));
    expect(result.size).toBeLessThanOrEqual(64);
  });

  it('joins array header values (Fastify may deliver repeated headers as an array)', () => {
    expect(parseAllowHeader(['abc123def456', '112233445566'])).toEqual(
      new Set(['abc123def456', '112233445566']),
    );
  });
});
