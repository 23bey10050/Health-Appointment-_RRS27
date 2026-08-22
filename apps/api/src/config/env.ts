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

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    // `::` listens on IPv6 and, on any normal machine, on IPv4 through the same socket. Binding
    // 0.0.0.0 instead looks harmless but costs every local caller about 200ms: browsers and curl
    // resolve `localhost` to ::1 first, get refused, and only then retry on 127.0.0.1. See the
    // fallback in main.ts for the rare host with IPv6 switched off entirely.
    HOST: z.string().min(1).default('::'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    // The default is written as an array, not a string, because Zod hands a default straight back as
    // the finished value instead of pushing it through the transform above.
    CORS_ORIGINS: commaSeparatedList.default(['http://localhost:5173']),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),

    DATABASE_URL: postgresUrl,
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(20_000),
    DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(8000),

    // Signs access tokens. 32 characters is the shortest a random secret can be and still carry
    // enough entropy to resist guessing; the `.env.local` template ships one that is long enough to
    // pass this check and clearly marked as a placeholder to replace before anything real depends on it.
    JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    // Long-lived on purpose: a patient booking a follow-up weeks out should not be forced to log in
    // again just to view it.
    JWT_REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),

    // All three are optional together. Leaving BREVO_API_KEY unset is a normal, fully supported way
    // to run this project — the outbox worker falls back to printing emails to the console instead of
    // refusing to start, which is what lets the whole booking flow be built and demoed before anyone
    // has signed up for an email provider.
    BREVO_API_KEY: z.string().min(1).optional(),
    BREVO_SENDER_EMAIL: z.string().email().optional(),
    BREVO_SENDER_NAME: z.string().min(1).max(100).default('Health Appointment Clinic'),

    // Same "optional, with a working fallback" shape as email above. With neither key set, a
    // booking or a submitted note still gets a deterministic template instead of a real AI
    // summary - a normal, fully supported way to run this project without signing up for anything.
    GROQ_API_KEY: z.string().min(1).optional(),
    GEMINI_API_KEY: z.string().min(1).optional(),

    // All four optional together, same shape again: with none of these set, booking and
    // cancelling an appointment simply create no calendar event for anyone, which is a normal,
    // fully supported way to run this project. Once set, they are required as a group - there is
    // no useful partial configuration, since an OAuth client is meaningless without its secret and
    // redirect URI, and stored tokens are meaningless without a key to decrypt them.
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    GOOGLE_REDIRECT_URI: z.string().url().optional(),
    // Must decode from base64 to exactly 32 bytes - AES-256-GCM's key length, not a stylistic
    // choice. Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
    GOOGLE_TOKEN_ENCRYPTION_KEY: z
      .string()
      .min(1)
      .refine((value) => Buffer.from(value, 'base64').length === 32, {
        message: 'must decode from base64 to exactly 32 bytes',
      })
      .optional(),
  })
  .refine((env) => !env.BREVO_API_KEY || env.BREVO_SENDER_EMAIL, {
    message: 'is required once BREVO_API_KEY is set, so Brevo has a "from" address to send with',
    path: ['BREVO_SENDER_EMAIL'],
  })
  .refine(
    (env) => {
      const google = [
        env.GOOGLE_CLIENT_ID,
        env.GOOGLE_CLIENT_SECRET,
        env.GOOGLE_REDIRECT_URI,
        env.GOOGLE_TOKEN_ENCRYPTION_KEY,
      ];
      const configured = google.filter((value) => value !== undefined).length;
      return configured === 0 || configured === google.length;
    },
    {
      message:
        'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI and GOOGLE_TOKEN_ENCRYPTION_KEY ' +
        'must all be set together, or all left blank',
      path: ['GOOGLE_CLIENT_ID'],
    },
  );

type RawEnv = z.infer<typeof envSchema>;

/**
 * The example secret checked into `.env.local`. Only exists so production can refuse to boot if
 * someone forgets to replace it — a mistake real deployments make often enough that catching it
 * here, once, is cheaper than hoping every future deploy remembers.
 */
const EXAMPLE_JWT_SECRET = 'dev-only-secret-change-before-deploying-anywhere-real';

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
  readonly auth: {
    readonly jwtAccessSecret: string;
    readonly accessTokenTtlSeconds: number;
    readonly refreshTokenTtlDays: number;
  };
  readonly email: {
    /** Undefined means "no account configured" — the console sender takes over. */
    readonly brevoApiKey: string | undefined;
    readonly senderEmail: string | undefined;
    readonly senderName: string;
  };
  readonly ai: {
    /** Undefined means "no account configured" — that provider is simply left out of the chain. */
    readonly groqApiKey: string | undefined;
    readonly geminiApiKey: string | undefined;
  };
  readonly google: {
    /** Either all four of these are set, or none are — enforced above at parse time, so nothing
     *  downstream has to handle a partially configured Google connection. */
    readonly clientId: string | undefined;
    readonly clientSecret: string | undefined;
    readonly redirectUri: string | undefined;
    readonly tokenEncryptionKey: string | undefined;
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

  if (env.NODE_ENV === 'production' && env.JWT_ACCESS_SECRET === EXAMPLE_JWT_SECRET) {
    throw new ConfigError([
      'JWT_ACCESS_SECRET: still set to the placeholder from .env.local. ' +
        'Generate a real secret before running in production.',
    ]);
  }

  // An empty CORS_ORIGINS parses cleanly to an empty list, which `server.ts` then reads as
  // "allow no origin at all". Locally that is harmless - nothing is calling across origins. In
  // production it is the worst kind of failure: /health and /ready both answer perfectly, the
  // database is fine, the logs are clean, and every single browser request is silently blocked
  // with no CORS header and no server-side trace of why. Refusing to boot turns a confusing
  // afternoon into one honest line in the deploy log.
  if (env.NODE_ENV === 'production' && env.CORS_ORIGINS.length === 0) {
    throw new ConfigError([
      'CORS_ORIGINS: empty in production, which would block every browser request. ' +
        'Set it to the exact origin the browser app is served from, ' +
        'for example https://your-app.workers.dev (comma-separate more than one).',
    ]);
  }

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
    auth: Object.freeze({
      jwtAccessSecret: env.JWT_ACCESS_SECRET,
      accessTokenTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
      refreshTokenTtlDays: env.JWT_REFRESH_TTL_DAYS,
    }),
    email: Object.freeze({
      brevoApiKey: env.BREVO_API_KEY,
      senderEmail: env.BREVO_SENDER_EMAIL,
      senderName: env.BREVO_SENDER_NAME,
    }),
    ai: Object.freeze({
      groqApiKey: env.GROQ_API_KEY,
      geminiApiKey: env.GEMINI_API_KEY,
    }),
    google: Object.freeze({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      redirectUri: env.GOOGLE_REDIRECT_URI,
      tokenEncryptionKey: env.GOOGLE_TOKEN_ENCRYPTION_KEY,
    }),
  });
}
