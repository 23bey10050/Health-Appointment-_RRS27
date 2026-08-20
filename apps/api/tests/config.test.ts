import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/config/env.js';

const MINIMUM_ENV = {
  DATABASE_URL: 'postgresql://health:health@localhost:5432/health_appointment',
} satisfies NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('fills in sensible defaults so a short .env still boots', () => {
    const config = loadConfig(MINIMUM_ENV);

    expect(config.port).toBe(4000);
    expect(config.nodeEnv).toBe('development');
    expect(config.isProduction).toBe(false);
    expect(config.corsOrigins).toEqual(['http://localhost:5173']);
  });

  it('refuses to start when the database URL is missing', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  it('lists every problem at once instead of stopping at the first', () => {
    let caught: ConfigError | undefined;

    try {
      loadConfig({ DATABASE_URL: 'mysql://nope', PORT: '99999' });
    } catch (error) {
      caught = error as ConfigError;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    expect(caught?.problems).toHaveLength(2);
    expect(caught?.problems.join(' ')).toContain('DATABASE_URL');
    expect(caught?.problems.join(' ')).toContain('PORT');
  });

  it('splits the CORS list and drops the stray spaces people leave behind', () => {
    const config = loadConfig({
      ...MINIMUM_ENV,
      CORS_ORIGINS: 'http://localhost:5173, https://clinic.example ,',
    });

    expect(config.corsOrigins).toEqual(['http://localhost:5173', 'https://clinic.example']);
  });
});
