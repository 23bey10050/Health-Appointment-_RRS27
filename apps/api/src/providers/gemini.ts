import type { SummaryPrompt, SummaryProvider } from '../modules/summaries/provider.js';
import { describeUnknownError } from '../shared/errors.js';

/**
 * Flash-Lite, not the flagship Flash or Pro models. Same reasoning as the Groq choice above: its
 * free-tier daily cap is the most generous of Gemini's current models, and this call only ever
 * needs to read a short paragraph and hand back a few sentences of JSON - not the kind of task
 * that benefits from a bigger model's extra reasoning depth.
 */
const GEMINI_MODEL = 'gemini-3.1-flash-lite';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

interface GeminiGenerateResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  error?: { message?: string };
}

/** The fallback behind Groq, called only when Groq has already failed twice. Same fetch-based,
 *  AbortController-timeout shape as the Groq adapter - the two are interchangeable to the chain
 *  that calls them, which is the whole point of the shared `SummaryProvider` interface. */
export class GeminiSummaryProvider implements SummaryProvider {
  readonly name = 'gemini';

  constructor(
    private readonly apiKey: string,
    private readonly timeoutMs = 8000,
  ) {}

  async complete(prompt: SummaryPrompt): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(GEMINI_URL, {
        method: 'POST',
        signal: controller.signal,
        // The API key travels as a header, not a query string, so it never ends up sitting in a
        // proxy access log or browser history the way a `?key=` on the URL would.
        headers: { 'x-goog-api-key': this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: prompt.system }] },
          contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
        }),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      throw new Error(`Could not reach Gemini: ${describeUnknownError(error)}`, { cause: error });
    } finally {
      clearTimeout(timeout);
    }

    const body = (await response.json().catch(() => ({}))) as GeminiGenerateResponse;
    if (!response.ok) {
      throw new Error(
        `Gemini rejected the request (HTTP ${response.status}): ${body.error?.message ?? 'no message given'}`,
      );
    }

    const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error('Gemini answered with no text content.');
    }
    return text;
  }
}
