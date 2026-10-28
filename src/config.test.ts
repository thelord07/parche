import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const WORKTREE_ROOT = resolve(new URL('.', import.meta.url).pathname, '..');

describe('loadConfig', () => {
  it('returns defaults when env is empty', () => {
    const config = loadConfig({});
    expect(config.port).toBe(8787);
    expect(config.host).toBe('127.0.0.1');
    expect(config.dataDir).toBe(resolve('./data'));
    expect(config.maxBlobBytes).toBe(20971520);
    expect(config.logLevel).toBe('info');
  });

  it('accepts PORT=3000', () => {
    const config = loadConfig({ PORT: '3000' });
    expect(config.port).toBe(3000);
  });

  it('throws ConfigError with /PORT/ when PORT=abc (AC9 unit)', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(ConfigError);
    try {
      loadConfig({ PORT: 'abc' });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toMatch(/PORT/);
    }
  });

  it('throws ConfigError naming PARCHE_MAX_BLOB_BYTES when negative', () => {
    expect(() => loadConfig({ PARCHE_MAX_BLOB_BYTES: '-1' })).toThrow(ConfigError);
    try {
      loadConfig({ PARCHE_MAX_BLOB_BYTES: '-1' });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toMatch(/PARCHE_MAX_BLOB_BYTES/);
    }
  });

  it('throws ConfigError naming PARCHE_LOG_LEVEL when value is loud', () => {
    expect(() => loadConfig({ PARCHE_LOG_LEVEL: 'loud' })).toThrow(ConfigError);
    try {
      loadConfig({ PARCHE_LOG_LEVEL: 'loud' });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toMatch(/PARCHE_LOG_LEVEL/);
    }
  });

  it('default logLevel is info', () => {
    const config = loadConfig({});
    expect(config.logLevel).toBe('info');
  });

  it('resolves PARCHE_DATA_DIR to an absolute path', () => {
    const config = loadConfig({ PARCHE_DATA_DIR: './mydata' });
    expect(config.dataDir).toBe(resolve('./mydata'));
  });
});

describe('AC9 integration — spawnSync with PORT=abc', () => {
  it('exits with non-zero and stderr names PORT', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: WORKTREE_ROOT,
      env: { ...process.env, PORT: 'abc' },
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(result.status).not.toBe(0);
    const output = (result.stderr ?? '') + (result.stdout ?? '');
    expect(output).toMatch(/PORT/);
  });
});
