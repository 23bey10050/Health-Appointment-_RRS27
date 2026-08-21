import { describe, expect, it, vi } from 'vitest';

import { signOAuthState, verifyOAuthState } from '../../../src/modules/calendar/state-token.js';

const SECRET = 'a-secret-at-least-thirty-two-characters';

describe('signOAuthState / verifyOAuthState', () => {
  it('round-trips the user id it was signed for', () => {
    const state = signOAuthState('user-123', SECRET);

    expect(verifyOAuthState(state, SECRET)).toBe('user-123');
  });

  it('rejects a state signed with a different secret', () => {
    const state = signOAuthState('user-123', SECRET);

    expect(verifyOAuthState(state, 'a-completely-different-secret-value')).toBeUndefined();
  });

  it('rejects a tampered payload even if the signature format still looks right', () => {
    const state = signOAuthState('user-123', SECRET);
    const [, signature] = state.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ userId: 'someone-else', expiresAt: Date.now() + 60_000 }), 'utf8').toString('base64url');

    expect(verifyOAuthState(`${forgedPayload}.${signature}`, SECRET)).toBeUndefined();
  });

  it('rejects garbage input without throwing', () => {
    expect(verifyOAuthState('not-a-real-state-token', SECRET)).toBeUndefined();
    expect(verifyOAuthState('', SECRET)).toBeUndefined();
  });

  it('rejects an expired state', () => {
    vi.useFakeTimers();
    const state = signOAuthState('user-123', SECRET);

    vi.advanceTimersByTime(11 * 60 * 1000);

    expect(verifyOAuthState(state, SECRET)).toBeUndefined();
    vi.useRealTimers();
  });
});
