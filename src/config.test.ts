import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertMailerConfigured, ConfigError, loadConfig } from './config.js';

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

  it('PARCHE_TRUST_PROXY absent → trustProxy is empty string', () => {
    const config = loadConfig({});
    expect(config.trustProxy).toBe('');
  });

  it('PARCHE_TRUST_PROXY valid single IP is preserved', () => {
    const config = loadConfig({ PARCHE_TRUST_PROXY: '172.28.0.1' });
    expect(config.trustProxy).toBe('172.28.0.1');
  });

  it('PARCHE_TRUST_PROXY valid comma-separated list is preserved', () => {
    const config = loadConfig({ PARCHE_TRUST_PROXY: '127.0.0.1,172.28.0.1' });
    expect(config.trustProxy).toBe('127.0.0.1,172.28.0.1');
  });

  it('PARCHE_TRUST_PROXY valid CIDR is preserved', () => {
    const config = loadConfig({ PARCHE_TRUST_PROXY: '172.28.0.0/16' });
    expect(config.trustProxy).toBe('172.28.0.0/16');
  });

  it('PARCHE_TRUST_PROXY accepts IPv6 and IPv6 CIDR', () => {
    expect(loadConfig({ PARCHE_TRUST_PROXY: '::1,fd00::/8' }).trustProxy).toBe('::1,fd00::/8');
  });

  it('PARCHE_TRUST_PROXY rejects hex-looking tokens that are not IPs and out-of-range prefixes', () => {
    for (const bad of [
      'deadbeef',
      'abc',
      '172.28.0.1/33',
      '::1/129',
      '10.0.0.1/8/8',
      '256.1.1.1',
    ]) {
      expect(() => loadConfig({ PARCHE_TRUST_PROXY: bad })).toThrow(ConfigError);
    }
  });

  it('PARCHE_TRUST_PROXY garbage throws ConfigError naming the variable', () => {
    expect(() => loadConfig({ PARCHE_TRUST_PROXY: 'not-an-ip!!' })).toThrow(ConfigError);
    try {
      loadConfig({ PARCHE_TRUST_PROXY: 'not-an-ip!!' });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toMatch(/PARCHE_TRUST_PROXY/);
    }
  });
});

describe('new PARCHE-006 config fields', () => {
  it('PARCHE_PUBLIC_URL is optional — loadConfig does not throw without it', () => {
    expect(() => loadConfig({})).not.toThrow();
    const cfg = loadConfig({});
    expect(cfg.publicUrl).toBeUndefined();
  });

  it('PARCHE_SMTP_URL is optional in loadConfig', () => {
    const cfg = loadConfig({});
    expect(cfg.smtpUrl).toBeUndefined();
  });

  it('PARCHE_CREATORS is normalized to lowercase and split', () => {
    const cfg = loadConfig({ PARCHE_CREATORS: '  Alice@Example.com , bob@test.com , ' });
    expect(cfg.creators).toEqual(['alice@example.com', 'bob@test.com']);
  });

  it('isCreator uses lowercase match', () => {
    const cfg = loadConfig({ PARCHE_CREATORS: 'Owner@Example.com' });
    expect(cfg.creators).toContain('owner@example.com');
    expect(cfg.creators).not.toContain('Owner@Example.com');
  });

  it('isProduction is true when NODE_ENV=production', () => {
    const cfg = loadConfig({ NODE_ENV: 'production' });
    expect(cfg.isProduction).toBe(true);
  });

  it('isProduction is false when NODE_ENV is unset or development', () => {
    const cfg1 = loadConfig({});
    expect(cfg1.isProduction).toBe(false);
    const cfg2 = loadConfig({ NODE_ENV: 'development' });
    expect(cfg2.isProduction).toBe(false);
  });

  it('mailFrom defaults to parche@<host of PARCHE_PUBLIC_URL>', () => {
    const cfg = loadConfig({ PARCHE_PUBLIC_URL: 'https://parche.example.com' });
    expect(cfg.mailFrom).toBe('parche@parche.example.com');
  });

  it('mailFrom uses explicit PARCHE_MAIL_FROM when set', () => {
    const cfg = loadConfig({
      PARCHE_PUBLIC_URL: 'https://parche.example.com',
      PARCHE_MAIL_FROM: 'noreply@custom.com',
    });
    expect(cfg.mailFrom).toBe('noreply@custom.com');
  });
});

describe('assertMailerConfigured (AC11)', () => {
  it('throws ConfigError naming PARCHE_SMTP_URL when smtpUrl is absent — production', () => {
    const cfg = loadConfig({ NODE_ENV: 'production', PARCHE_PUBLIC_URL: 'https://example.com' });
    expect(() => assertMailerConfigured(cfg)).toThrow(ConfigError);
    try {
      assertMailerConfigured(cfg);
    } catch (err) {
      expect((err as ConfigError).message).toMatch(/PARCHE_SMTP_URL/);
    }
  });

  it('throws ConfigError naming PARCHE_SMTP_URL when smtpUrl is absent — dev/unset NODE_ENV', () => {
    const cfg = loadConfig({});
    expect(() => assertMailerConfigured(cfg)).toThrow(ConfigError);
    try {
      assertMailerConfigured(cfg);
    } catch (err) {
      expect((err as ConfigError).message).toMatch(/PARCHE_SMTP_URL/);
    }
  });

  it('throws ConfigError when smtpUrl does not start with smtp:// or smtps://', () => {
    const cfg = loadConfig({ PARCHE_SMTP_URL: 'http://localhost:1025' });
    expect(() => assertMailerConfigured(cfg)).toThrow(ConfigError);
  });

  it('does NOT throw when smtpUrl starts with smtp://', () => {
    const cfg = loadConfig({ PARCHE_SMTP_URL: 'smtp://localhost:1025' });
    expect(() => assertMailerConfigured(cfg)).not.toThrow();
  });

  it('throws ConfigError naming PARCHE_PUBLIC_URL in production without it, even with SMTP', () => {
    const cfg = loadConfig({ NODE_ENV: 'production', PARCHE_SMTP_URL: 'smtps://u:p@host:465' });
    expect(() => assertMailerConfigured(cfg)).toThrow(/PARCHE_PUBLIC_URL/);
  });

  it('does NOT require PARCHE_PUBLIC_URL outside production', () => {
    const cfg = loadConfig({ PARCHE_SMTP_URL: 'smtp://127.0.0.1:1025' });
    expect(assertMailerConfigured(cfg)).toBe('smtp://127.0.0.1:1025');
  });

  it('does NOT throw when smtpUrl starts with smtps://', () => {
    const cfg = loadConfig({ PARCHE_SMTP_URL: 'smtps://user:pass@host:465' });
    expect(() => assertMailerConfigured(cfg)).not.toThrow();
  });
});

describe('AC11 integration — spawnSync without SMTP', () => {
  it('main.ts exits non-zero naming PARCHE_SMTP_URL when NODE_ENV=production', () => {
    const env = { ...process.env };
    delete env.PARCHE_SMTP_URL;
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: WORKTREE_ROOT,
      env: {
        ...env,
        NODE_ENV: 'production',
        PARCHE_PUBLIC_URL: 'https://parche.example.com',
        PARCHE_CREATORS: 'test@example.com',
      },
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(result.status).not.toBe(0);
    const output = (result.stderr ?? '') + (result.stdout ?? '');
    expect(output).toMatch(/PARCHE_SMTP_URL/);
  });

  it('main.ts exits non-zero naming PARCHE_SMTP_URL when NODE_ENV is unset', () => {
    const env = { ...process.env };
    delete env.NODE_ENV;
    delete env.PARCHE_SMTP_URL;
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: WORKTREE_ROOT,
      env: {
        ...env,
        PARCHE_PUBLIC_URL: 'https://parche.example.com',
        PARCHE_CREATORS: 'test@example.com',
      },
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(result.status).not.toBe(0);
    const output = (result.stderr ?? '') + (result.stdout ?? '');
    expect(output).toMatch(/PARCHE_SMTP_URL/);
  });

  it('admin CLI (backup-db) exits 0 without PARCHE_SMTP_URL', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tmp = await mkdtemp(join(tmpdir(), 'parche-ac11-'));
    const dest = join(tmp, 'backup.db');
    const env: NodeJS.ProcessEnv = { ...process.env, PARCHE_DATA_DIR: tmp };
    delete env.PARCHE_SMTP_URL;
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/admin/cli.ts', 'backup-db', dest],
      {
        cwd: WORKTREE_ROOT,
        env,
        encoding: 'utf8',
        timeout: 15000,
      },
    );
    await rm(tmp, { recursive: true, force: true });
    expect(result.status).toBe(0);
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
