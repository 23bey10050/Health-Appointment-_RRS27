import { z } from 'zod';

/**
 * A connection string Postgres will actually accept. Checking the scheme here catches the classic
 * copy-paste mistake of pasting a dashboard URL instead of a connection string, and it catches it
 * at boot instead of on the first query.
 */
const postgresUrl = z
  .string()
  .min(1)
  .refine((value) => value.startsWith('postgres://') || value.startsWith('postgresql://'), {
    message: 'must start with postgres:// or postgresql://',
  });

const commaSeparatedList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )
  .pipe(z.array(z.string().min(1)));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  // `::` listens on IPv6 and, on any normal machine, on IPv4 through the same socket. Binding
  // 0.0.0.0 instead looks harmless but costs every local caller about 200ms: browsers and curl
  // resolve `localhost` to ::1 first, get refused, and only then retry on 127.0.0.1. See the
  // fallback in main.ts for the rare host with IPv6 switched off entirely.
  HOST: z.string().min(1).default('::'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // The default is written as an array, not a string, because Zod hands a default straight back as
  // the finished value instead of pushing it through the transform above.
  CORS_ORIGINS: commaSeparatedList.default(['http://localhost:5173']),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),

  DATABASE_URL: postgresUrl,
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(20_000),
  DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(8000),
});

type RawEnv = z.infer<typeof envSchema>;

/** Everything the app is allowed to know about its surroundings, already checked and typed. */
export interface AppConfig {
  readonly nodeEnv: RawEnv['NODE_ENV'];
  readonly isProduction: boolean;
  readonly isTest: boolean;
  readonly port: number;
  readonly host: string;
  readonly logLevel: RawEnv['LOG_LEVEL'];
  readonly corsOrigins: readonly string[];
  readonly shutdownTimeoutMs: number;
  readonly database: {
    readonly url: string;
    readonly poolMax: number;
    readonly idleTimeoutMs: number;
    readonly connectTimeoutMs: number;
  };
}

/** Thrown only at startup, and it carries the whole list of problems rather than the first one. */
export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Environment is not usable:\n${problems.map((line) => `  - ${line}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Reads the environment once and hands back a frozen, fully typed config.
 *
 * Failing loudly here is the whole point. A missing DATABASE_URL should stop the server before it
 * accepts a single request, not surface as an unreadable crash while a patient is mid-booking.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const variable = issue.path.join('.') || '(unknown variable)';
      return `${variable}: ${issue.message}`;
    });
    throw new ConfigError(problems);
  }

  const env = parsed.data;

  return Object.freeze({
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    port: env.PORT,
    host: env.HOST,
    logLevel: env.LOG_LEVEL,
    corsOrigins: Object.freeze(env.CORS_ORIGINS),
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    database: Object.freeze({
      url: env.DATABASE_URL,
      poolMax: env.DATABASE_POOL_MAX,
      idleTimeoutMs: env.DATABASE_IDLE_TIMEOUT_MS,
      connectTimeoutMs: env.DATABASE_CONNECT_TIMEOUT_MS,
    }),
  });
}
