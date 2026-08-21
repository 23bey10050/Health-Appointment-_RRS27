import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';

import { runSummaryChain } from '../../../src/modules/summaries/chain.js';
import type { SummaryPrompt, SummaryProvider } from '../../../src/modules/summaries/provider.js';

const schema = z.object({ answer: z.string() });
const prompt: SummaryPrompt = { system: 'be helpful', user: 'summarise this' };

/** A `callCount()` closure instead of asserting on `provider.complete` directly - referencing a
 *  method straight off an interface-typed object trips the lint rule against unbound methods, and
 *  this sidesteps that without losing the check. */
function providerReturning(name: string, text: string) {
  const complete = vi.fn().mockResolvedValue(text);
  return {
    provider: { name, complete } satisfies SummaryProvider,
    callCount: () => complete.mock.calls.length,
  };
}

function providerRejecting(name: string, error: unknown) {
  const complete = vi.fn().mockRejectedValue(error);
  return {
    provider: { name, complete } satisfies SummaryProvider,
    callCount: () => complete.mock.calls.length,
  };
}

describe('runSummaryChain', () => {
  it('accepts the first provider straight away when its answer is valid', async () => {
    const groq = providerReturning('groq', '{"answer":"all good"}');
    const gemini = providerReturning('gemini', '{"answer":"should never be called"}');

    const result = await runSummaryChain([groq.provider, gemini.provider], prompt, schema);

    expect(result.success).toEqual({ value: { answer: 'all good' }, provider: 'groq' });
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.outcome).toBe('success');
    expect(gemini.callCount()).toBe(0);
  });

  it('strips a markdown code fence a model wraps its JSON in out of habit', async () => {
    const groq = providerReturning('groq', '```json\n{"answer":"fenced"}\n```');

    const result = await runSummaryChain([groq.provider], prompt, schema);

    expect(result.success?.value).toEqual({ answer: 'fenced' });
  });

  it('gives the first provider a second try before moving on to the next one', async () => {
    const complete = vi
      .fn()
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce('{"answer":"worked on retry"}');
    const groq = { name: 'groq', complete } satisfies SummaryProvider;
    const gemini = providerReturning('gemini', '{"answer":"should not be needed"}');

    const result = await runSummaryChain([groq, gemini.provider], prompt, schema);

    expect(result.success).toEqual({ value: { answer: 'worked on retry' }, provider: 'groq' });
    expect(complete.mock.calls.length).toBe(2);
    expect(gemini.callCount()).toBe(0);
  });

  it('falls through to the second provider once the first has failed twice', async () => {
    const groq = providerRejecting('groq', new Error('down'));
    const gemini = providerReturning('gemini', '{"answer":"gemini saved it"}');

    const result = await runSummaryChain([groq.provider, gemini.provider], prompt, schema);

    expect(result.success).toEqual({ value: { answer: 'gemini saved it' }, provider: 'gemini' });
    expect(groq.callCount()).toBe(2);
    expect(result.attempts).toHaveLength(3);
  });

  it('reports every provider failing rather than throwing', async () => {
    const groq = providerRejecting('groq', new Error('down'));
    const gemini = providerRejecting('gemini', new Error('also down'));

    const result = await runSummaryChain([groq.provider, gemini.provider], prompt, schema);

    expect(result.success).toBeUndefined();
    expect(result.attempts.map((attempt) => attempt.outcome)).toEqual(['error', 'error', 'error']);
  });

  it('an aborted call is classified as a timeout, not a generic error', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    const groq = providerRejecting('groq', abortError);

    const result = await runSummaryChain([groq.provider], prompt, schema);

    expect(result.attempts.every((attempt) => attempt.outcome === 'timeout')).toBe(true);
  });

  it('text that is not JSON at all is reported as invalid_json, not a crash', async () => {
    const groq = providerReturning('groq', 'Sorry, I cannot help with that.');

    const result = await runSummaryChain([groq.provider], prompt, schema);

    expect(result.success).toBeUndefined();
    expect(result.attempts[0]?.outcome).toBe('invalid_json');
  });

  it('valid JSON in the wrong shape is reported as schema_mismatch', async () => {
    const groq = providerReturning('groq', '{"somethingElse": 1}');

    const result = await runSummaryChain([groq.provider], prompt, schema);

    expect(result.attempts[0]?.outcome).toBe('schema_mismatch');
  });

  it('an empty provider list - both AI keys left blank - returns with no attempts made', async () => {
    const result = await runSummaryChain([], prompt, schema);

    expect(result.success).toBeUndefined();
    expect(result.attempts).toEqual([]);
  });
});
