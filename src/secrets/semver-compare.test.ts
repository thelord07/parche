import { describe, expect, it } from 'vitest';
import { isSemverGreater } from './semver-compare.js';

describe('isSemverGreater', () => {
  it('true cuando a es mayor en major/minor/patch', () => {
    expect(isSemverGreater('2.0.0', '1.15.1')).toBe(true);
    expect(isSemverGreater('1.16.0', '1.15.1')).toBe(true);
    expect(isSemverGreater('1.15.2', '1.15.1')).toBe(true);
  });

  it('false cuando son iguales', () => {
    expect(isSemverGreater('1.15.1', '1.15.1')).toBe(false);
  });

  it('false cuando a es menor', () => {
    expect(isSemverGreater('1.0.0', '1.15.1')).toBe(false);
    expect(isSemverGreater('0.0.1', '1.15.1')).toBe(false);
  });

  it('false cuando cualquiera no es parseable (rollback safety)', () => {
    expect(isSemverGreater('unknown', '1.15.1')).toBe(false);
    expect(isSemverGreater('1.15.1', 'unknown')).toBe(false);
    expect(isSemverGreater(null, '1.15.1')).toBe(false);
    expect(isSemverGreater('1.15.1', null)).toBe(false);
    expect(isSemverGreater(undefined, undefined)).toBe(false);
    expect(isSemverGreater('not-a-version', '1.0.0')).toBe(false);
  });

  it('pre-release tratado conservadoramente: nunca "mayor" aunque el núcleo numérico lo sea', () => {
    expect(isSemverGreater('1.15.2-beta.1', '1.15.1')).toBe(false);
    expect(isSemverGreater('2.0.0', '1.15.1-rc.1')).toBe(false);
    expect(isSemverGreater('1.15.2-beta.1', '1.15.1-alpha.1')).toBe(false);
  });

  it('regex anclada en ambos extremos — rechaza basura al final o de más (review ronda 2 nit)', () => {
    expect(isSemverGreater('1.15.1garbage', '1.0.0')).toBe(false);
    expect(isSemverGreater('1.15.1.2.3', '1.0.0')).toBe(false);
    expect(isSemverGreater('2.0.0', '1.15.1garbage')).toBe(false);
    // Un valor exacto, sin basura, sigue funcionando.
    expect(isSemverGreater('2.0.0', '1.15.1')).toBe(true);
  });
});
