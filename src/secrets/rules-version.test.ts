/**
 * PARCHE-013 (review ronda 1 #2) — `computeRulesVersion` nunca lanza: se
 * testea su lógica pura con dependencias inyectadas, sin mockear
 * `node:module`/`node:fs` a nivel de proceso.
 */
import { describe, expect, it, vi } from 'vitest';
import { computeRulesVersion, RULES_VERSION, UNKNOWN_RULES_VERSION } from './rules-version.js';

describe('computeRulesVersion', () => {
  it('usa el valor inyectado en build time cuando existe y no es "unknown"', () => {
    const version = computeRulesVersion({
      buildTimeVersion: '1.15.1',
      readRuntimeVersion: () => {
        throw new Error('no debería llamarse — el build-time version ya resolvió');
      },
    });
    expect(version).toBe('1.15.1');
  });

  it('cae al fallback de runtime cuando no hay build-time version (undefined — dev/tsx/Vitest)', () => {
    const version = computeRulesVersion({
      buildTimeVersion: undefined,
      readRuntimeVersion: () => '1.15.1',
    });
    expect(version).toBe('1.15.1');
  });

  it('cae al fallback de runtime cuando el build-time version es literalmente "unknown"', () => {
    const version = computeRulesVersion({
      buildTimeVersion: UNKNOWN_RULES_VERSION,
      readRuntimeVersion: () => '1.15.1',
    });
    expect(version).toBe('1.15.1');
  });

  it('degrada a UNKNOWN_RULES_VERSION (nunca lanza) cuando ninguna fuente resuelve, y avisa por stderr sin secretos ni rutas', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const version = computeRulesVersion({
        buildTimeVersion: undefined,
        readRuntimeVersion: () => null,
      });
      expect(version).toBe(UNKNOWN_RULES_VERSION);
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const [message] = stderrSpy.mock.calls[0] as [string];
      expect(message).toContain('@chamba/core');
      // Sin rutas de archivo: ninguna extensión escaneable, y el único "/"
      // permitido es el del propio nombre del paquete (@chamba/core).
      expect(message).not.toMatch(/\.md|\.canvas|\.base|\.svg/);
      expect(message.split('/')).toHaveLength(2);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('no lanza aunque readRuntimeVersion lance — degrada a UNKNOWN_RULES_VERSION', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(() =>
        computeRulesVersion({
          buildTimeVersion: undefined,
          readRuntimeVersion: () => {
            throw new Error('fs blew up');
          },
        }),
      ).not.toThrow();
      const version = computeRulesVersion({
        buildTimeVersion: undefined,
        readRuntimeVersion: () => {
          throw new Error('fs blew up');
        },
      });
      expect(version).toBe(UNKNOWN_RULES_VERSION);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe('RULES_VERSION (integración real)', () => {
  it('se resuelve a una versión real instalada (no explota el arranque)', () => {
    expect(typeof RULES_VERSION).toBe('string');
    expect(RULES_VERSION.length).toBeGreaterThan(0);
  });
});
