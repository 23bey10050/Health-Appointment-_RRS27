import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/config/env.js';

const MINIMUM_ENV = {
  DATABASE_URL: 'postgresql://health:health@localhost:5432/health_appointment',
  JWT_ACCESS_SECRET: 'a-secret-at-least-thirty-two-characters',
} satisfies NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('fills in sensible defaults so a short .env still boots', () => {
    const config = loadConfig(MINIMUM_ENV);

    expect(config.port).toBe(4000);
    expect(config.nodeEnv).toBe('development');
    expect(config.isProduction).toBe(false);
    expect(config.corsOrigins).toEqual(['http://localhost:5173']);
    expect(config.auth.accessTokenTtlSeconds).toBe(900);
    expect(config.auth.refreshTokenTtlDays).toBe(30);
  });

  it('refuses to start when required variables are missing', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  it('lists every problem at once instead of stopping at the first', () => {
    let caught: ConfigError | undefined;

    try {
      loadConfig({ DATABASE_URL: 'mysql://nope', PORT: '99999', JWT_ACCESS_SECRET: 'too-short' });
    } catch (error) {
      caught = error as ConfigError;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    expect(caught?.problems).toHaveLength(3);
    expect(caught?.problems.join(' ')).toContain('DATABASE_URL');
    expect(caught?.problems.join(' ')).toContain('PORT');
    expect(caught?.problems.join(' ')).toContain('JWT_ACCESS_SECRET');
  });

  it('splits the CORS list and drops the stray spaces people leave behind', () => {
    const config = loadConfig({
      ...MINIMUM_ENV,
      CORS_ORIGINS: 'http://localhost:5173, https://clinic.example ,',
    });

    expect(config.corsOrigins).toEqual(['http://localhost:5173', 'https://clinic.example']);
  });

  it('refuses to boot in production with the placeholder secret still in place', () => {
    expect(() =>
      loadConfig({
        ...MINIMUM_ENV,
        NODE_ENV: 'production',
        JWT_ACCESS_SECRET: 'dev-only-secret-change-before-deploying-anywhere-real',
      }),
    ).toThrow(/placeholder/);
  });

  it('accepts the placeholder secret outside production, so local dev needs no setup', () => {
    expect(() =>
      loadConfig({
        ...MINIMUM_ENV,
        JWT_ACCESS_SECRET: 'dev-only-secret-change-before-deploying-anywhere-real',
      }),
    ).not.toThrow();
  });

  it('runs with no Brevo account configured at all - the console sender takes over', () => {
    const config = loadConfig(MINIMUM_ENV);

    expect(config.email.brevoApiKey).toBeUndefined();
    expect(config.email.senderEmail).toBeUndefined();
    expect(config.email.senderName).toBe('Health Appointment Clinic');
  });

  it('refuses a Brevo API key with no sender address to send from', () => {
    let caught: ConfigError | undefined;

    try {
      loadConfig({ ...MINIMUM_ENV, BREVO_API_KEY: 'a-real-looking-key' });
    } catch (error) {
      caught = error as ConfigError;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    expect(caught?.problems.join(' ')).toContain('BREVO_SENDER_EMAIL');
  });

  it('accepts a Brevo key once a sender address is also given', () => {
    const config = loadConfig({
      ...MINIMUM_ENV,
      BREVO_API_KEY: 'a-real-looking-key',
      BREVO_SENDER_EMAIL: 'noreply@clinic.test',
    });

    expect(config.email.brevoApiKey).toBe('a-real-looking-key');
    expect(config.email.senderEmail).toBe('noreply@clinic.test');
  });

  it('runs with neither AI account configured - the deterministic template takes over', () => {
    const config = loadConfig(MINIMUM_ENV);

    expect(config.ai.groqApiKey).toBeUndefined();
    expect(config.ai.geminiApiKey).toBeUndefined();
  });

  it('accepts either AI key on its own, or both together', () => {
    const groqOnly = loadConfig({ ...MINIMUM_ENV, GROQ_API_KEY: 'a-groq-key' });
    const both = loadConfig({ ...MINIMUM_ENV, GROQ_API_KEY: 'a-groq-key', GEMINI_API_KEY: 'a-gemini-key' });

    expect(groqOnly.ai.groqApiKey).toBe('a-groq-key');
    expect(groqOnly.ai.geminiApiKey).toBeUndefined();
    expect(both.ai.geminiApiKey).toBe('a-gemini-key');
  });

  const REAL_GOOGLE_ENV = {
    GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'a-secret',
    GOOGLE_REDIRECT_URI: 'http://localhost:4000/auth/google/callback',
    GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  };

  it('runs with no Google account configured - booking and cancelling simply create no calendar event', () => {
    const config = loadConfig(MINIMUM_ENV);

    expect(config.google.clientId).toBeUndefined();
    expect(config.google.tokenEncryptionKey).toBeUndefined();
  });

  it('accepts all four Google values set together', () => {
    const config = loadConfig({ ...MINIMUM_ENV, ...REAL_GOOGLE_ENV });

    expect(config.google.clientId).toBe(REAL_GOOGLE_ENV.GOOGLE_CLIENT_ID);
    expect(config.google.tokenEncryptionKey).toBe(REAL_GOOGLE_ENV.GOOGLE_TOKEN_ENCRYPTION_KEY);
  });

  it('refuses a Google client id with none of the other three set', () => {
    let caught: ConfigError | undefined;

    try {
      loadConfig({ ...MINIMUM_ENV, GOOGLE_CLIENT_ID: REAL_GOOGLE_ENV.GOOGLE_CLIENT_ID });
    } catch (error) {
      caught = error as ConfigError;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    expect(caught?.problems.join(' ')).toContain('GOOGLE_CLIENT_ID');
  });

  it('refuses a token encryption key that does not decode to exactly 32 bytes', () => {
    let caught: ConfigError | undefined;

    try {
      loadConfig({
        ...MINIMUM_ENV,
        ...REAL_GOOGLE_ENV,
        GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(16, 7).toString('base64'),
      });
    } catch (error) {
      caught = error as ConfigError;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    expect(caught?.problems.join(' ')).toContain('32 bytes');
  });
});
