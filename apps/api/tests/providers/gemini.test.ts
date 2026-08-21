import { afterEach, describe, expect, it, vi } from 'vitest';

import { GeminiSummaryProvider } from '../../src/providers/gemini.js';
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

describe('GeminiSummaryProvider', () => {
  it('sends the exact request shape Gemini documents for generateContent', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { candidates: [{ content: { parts: [{ text: '{"answer":"ok"}' }] } }] }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new GeminiSummaryProvider('the-api-key');

    const result = await provider.complete(prompt);

    expect(result).toBe('{"answer":"ok"}');
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent',
    );
    expect(options.headers).toMatchObject({
      'x-goog-api-key': 'the-api-key',
      'Content-Type': 'application/json',
    });
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      systemInstruction: { parts: [{ text: prompt.system }] },
      contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
      generationConfig: { responseMimeType: 'application/json' },
    });
  });

  it('throws a clear error naming the HTTP status and Gemini message on a rejection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(400, { error: { message: 'API key not valid' } })),
    );
    const provider = new GeminiSummaryProvider('bad-key');

    await expect(provider.complete(prompt)).rejects.toThrow(/HTTP 400.*API key not valid/s);
  });

  it('wraps a network failure instead of leaking the raw fetch error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const provider = new GeminiSummaryProvider('key');

    await expect(provider.complete(prompt)).rejects.toThrow(/Could not reach Gemini/);
  });

  it('lets an aborted request through unwrapped, so a caller can still tell it was a timeout', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));
    const provider = new GeminiSummaryProvider('key');

    await expect(provider.complete(prompt)).rejects.toBe(abortError);
  });

  it('rejects when Gemini answers with no text content to work with', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { candidates: [] })));
    const provider = new GeminiSummaryProvider('key');

    await expect(provider.complete(prompt)).rejects.toThrow(/no text content/);
  });
});
