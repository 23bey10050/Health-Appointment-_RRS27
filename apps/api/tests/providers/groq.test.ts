import { afterEach, describe, expect, it, vi } from 'vitest';

import { GroqSummaryProvider } from '../../src/providers/groq.js';
import type { SummaryPrompt } from '../../src/modules/summaries/provider.js';

const prompt: SummaryPrompt = { system: 'be a triage assistant', user: 'headache for three days' };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('GroqSummaryProvider', () => {
  it('sends the exact request shape Groq documents for its chat completions endpoint', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { choices: [{ message: { content: '{"answer":"ok"}' } }] }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new GroqSummaryProvider('the-api-key');

    const result = await provider.complete(prompt);

    expect(result).toBe('{"answer":"ok"}');
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(options.headers).toMatchObject({
      Authorization: 'Bearer the-api-key',
      'Content-Type': 'application/json',
    });
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      response_format: { type: 'json_object' },
    });
  });

  it('throws a clear error naming the HTTP status and Groq message on a rejection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(401, { error: { message: 'Invalid API Key' } })),
    );
    const provider = new GroqSummaryProvider('bad-key');

    await expect(provider.complete(prompt)).rejects.toThrow(/HTTP 401.*Invalid API Key/s);
  });

  it('wraps a network failure instead of leaking the raw fetch error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const provider = new GroqSummaryProvider('key');

    await expect(provider.complete(prompt)).rejects.toThrow(/Could not reach Groq/);
  });

  it('lets an aborted request through unwrapped, so a caller can still tell it was a timeout', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));
    const provider = new GroqSummaryProvider('key');

    await expect(provider.complete(prompt)).rejects.toBe(abortError);
  });

  it('rejects when Groq answers with no message content to work with', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { choices: [] })));
    const provider = new GroqSummaryProvider('key');

    await expect(provider.complete(prompt)).rejects.toThrow(/no message content/);
  });
});
