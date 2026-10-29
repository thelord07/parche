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
});

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  maxBlobBytes: number;
  logLevel: LogLevel;
  trustProxy: string;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
  constructor(message: string) {
    super(message);
  }
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
  return {
    port: data.PORT,
    host: data.HOST,
    dataDir: resolve(data.PARCHE_DATA_DIR),
    maxBlobBytes: data.PARCHE_MAX_BLOB_BYTES,
    logLevel: data.PARCHE_LOG_LEVEL,
    trustProxy: data.PARCHE_TRUST_PROXY,
  };
}
