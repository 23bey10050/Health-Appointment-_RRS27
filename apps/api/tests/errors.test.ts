import { describe, expect, it } from 'vitest';

import { AppError, describeUnknownError, isAppError, NotFoundError } from '../src/shared/errors.js';

describe('describeUnknownError', () => {
  it('uses the message of an ordinary error', () => {
    expect(describeUnknownError(new Error('slot already taken'))).toBe('slot already taken');
  });

  it('unpacks an AggregateError, which is what a refused database connection looks like', () => {
    // Node dials IPv6 and IPv4 at the same time, so both failures arrive wrapped together and the
    // wrapper itself carries no message at all.
    const failure = new AggregateError([
      new Error('connect ECONNREFUSED ::1:5432'),
      new Error('connect ECONNREFUSED 127.0.0.1:5432'),
    ]);

    expect(describeUnknownError(failure)).toBe(
      'connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432',
    );
  });

  it('collapses repeated reasons so the line stays readable', () => {
    const failure = new AggregateError([new Error('timed out'), new Error('timed out')]);

    expect(describeUnknownError(failure)).toBe('timed out');
  });

  it('falls back to the name and code when an error carries no message', () => {
    const silent = Object.assign(new Error(''), { code: 'ECONNREFUSED' });

    expect(describeUnknownError(silent)).toBe('Error (ECONNREFUSED)');
  });

  it('handles values that are not errors at all', () => {
    expect(describeUnknownError('plain string failure')).toBe('plain string failure');
    expect(describeUnknownError(undefined)).toBe('Unknown error');
    expect(describeUnknownError({ nothing: true })).toBe('Unknown error');
  });
});

describe('AppError', () => {
  it('keeps its status, code and subclass name', () => {
    const error = new NotFoundError('No doctor with that id.');

    expect(error.statusCode).toBe(404);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.name).toBe('NotFoundError');
    expect(isAppError(error)).toBe(true);
  });

  it('does not mistake an ordinary error for a planned one', () => {
    expect(isAppError(new Error('boom'))).toBe(false);
  });

  it('carries validation details when they are given', () => {
    const error = new AppError(400, 'BAD_REQUEST', 'Check the form.', {
      details: [{ path: 'email', message: 'is required' }],
    });

    expect(error.details).toEqual([{ path: 'email', message: 'is required' }]);
  });
});
