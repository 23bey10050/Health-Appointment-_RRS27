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
});
