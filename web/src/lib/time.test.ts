import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { timeAgo } from './time.ts';

describe('timeAgo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('usa singular para un día y plural para varios', () => {
    expect(timeAgo('2026-11-03T11:00:00Z')).toBe('hace 1 día');
    expect(timeAgo('2026-11-01T11:00:00Z')).toBe('hace 3 días');
  });
});
