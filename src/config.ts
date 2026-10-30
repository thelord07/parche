import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

// Each comma-separated token must be an IPv4/IPv6 address, optionally with a CIDR
// prefix that fits its family (`proxy-addr`, used by Fastify, accepts the same forms).
function isIpOrCidr(token: string): boolean {
  const [addr, prefix, ...rest] = token.split('/');
  if (addr === undefined || rest.length > 0) return false;
  const family = isIP(addr);
  if (family === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

function validateTrustProxy(value: string): boolean {
  if (value === '') return true;
  return value.split(',').every((token) => isIpOrCidr(token.trim()));
}

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HOST: z.string().default('127.0.0.1'),
  PARCHE_DATA_DIR: z.string().default('./data'),
  PARCHE_MAX_BLOB_BYTES: z.coerce.number().int().positive().default(20971520),
  PARCHE_LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  PARCHE_TRUST_PROXY: z.string().optional().default('').refine(validateTrustProxy, {
    message:
      'PARCHE_TRUST_PROXY must be empty or a comma-separated list of IP addresses / CIDR blocks',
  }),
  // New in PARCHE-006
  PARCHE_PUBLIC_URL: z.string().url().optional(),
  PARCHE_SMTP_URL: z.string().optional(),
  PARCHE_MAIL_FROM: z.string().optional(),
  PARCHE_CREATORS: z.string().optional().default(''),
});

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  maxBlobBytes: number;
  logLevel: LogLevel;
  trustProxy: string;
  // New in PARCHE-006
  publicUrl: string | undefined;
  smtpUrl: string | undefined;
  mailFrom: string;
  creators: string[];
  isProduction: boolean;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
  constructor(message: string) {
    super(message);
  }
}

/**
 * Assert that the mailer is fully configured (SMTP URL present and valid scheme).
 * In production PARCHE_PUBLIC_URL is required too: sign-in links are built from it
 * (never from the Host header), so a missing value would mail links to localhost.
 * Called from main.ts — the server will not start without it.
 * The admin CLI does NOT call this.
 */
export function assertMailerConfigured(config: Config): string {
  if (config.isProduction && !config.publicUrl) {
    throw new ConfigError(
      'PARCHE_PUBLIC_URL is required in production (sign-in links are built from it).',
    );
  }
  if (!config.smtpUrl) {
    throw new ConfigError(
      'PARCHE_SMTP_URL is required to start the server. Set it to an smtp:// or smtps:// URL.',
    );
  }
  if (!config.smtpUrl.startsWith('smtp://') && !config.smtpUrl.startsWith('smtps://')) {
    throw new ConfigError('PARCHE_SMTP_URL must start with smtp:// or smtps://');
  }
  return config.smtpUrl;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const messages = result.error.issues
      .map((issue) => {
        const path = issue.path.join('.');
        return `${path}: ${issue.message}`;
      })
      .join('; ');
    throw new ConfigError(`invalid parche configuration: ${messages}`);
  }
  const data = result.data;

  // Derive mailFrom: either explicit or parche@<host of publicUrl>
  let mailFrom = data.PARCHE_MAIL_FROM;
  if (!mailFrom && data.PARCHE_PUBLIC_URL) {
    try {
      const host = new URL(data.PARCHE_PUBLIC_URL).hostname;
      mailFrom = `parche@${host}`;
    } catch {
      mailFrom = 'parche@localhost';
    }
  }
  if (!mailFrom) mailFrom = 'parche@localhost';

  // Normalize creators: split by comma, trim, lowercase, filter empty
  const creators = data.PARCHE_CREATORS.split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);

  return {
    port: data.PORT,
    host: data.HOST,
    dataDir: resolve(data.PARCHE_DATA_DIR),
    maxBlobBytes: data.PARCHE_MAX_BLOB_BYTES,
    logLevel: data.PARCHE_LOG_LEVEL,
    trustProxy: data.PARCHE_TRUST_PROXY,
    publicUrl: data.PARCHE_PUBLIC_URL,
    smtpUrl: data.PARCHE_SMTP_URL,
    mailFrom,
    creators,
    isProduction: env.NODE_ENV === 'production',
  };
}
