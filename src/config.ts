import { resolve } from 'node:path';
import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HOST: z.string().default('127.0.0.1'),
  PARCHE_DATA_DIR: z.string().default('./data'),
  PARCHE_MAX_BLOB_BYTES: z.coerce.number().int().positive().default(20971520),
  PARCHE_LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  maxBlobBytes: number;
  logLevel: LogLevel;
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
  };
}
