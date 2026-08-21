import type { SummaryPrompt, SummaryProvider } from '../modules/summaries/provider.js';
import { describeUnknownError } from '../shared/errors.js';

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Llama 3.3 70B, not one of Groq's newer models. Its free-tier daily cap (shared across the
 * Llama family, 14,400 requests a day at the time this was chosen) is well over an order of
 * magnitude more generous than `openai/gpt-oss-120b`'s 1,000 requests a day - and a clinic's
 * volume of pre- and post-visit summaries is exactly the kind of steady, everyday load where the
 * daily ceiling matters far more than squeezing out extra reasoning quality per call.
 */
const GROQ_MODEL = 'llama-3.3-70b-versatile';

interface GroqChatResponse {
  choices?: { message?: { content?: string } }[];
  error?: { message?: string };
}

/** Turns a system/user prompt into raw text via Groq's OpenAI-compatible chat endpoint. Mirrors
 *  the Brevo adapter's shape on purpose: fetch, no extra HTTP client, an AbortController timeout,
 *  and errors that say plainly what went wrong instead of leaking a raw stack trace upward. */
export class GroqSummaryProvider implements SummaryProvider {
  readonly name = 'groq';

  constructor(
    private readonly apiKey: string,
    private readonly timeoutMs = 8000,
  ) {}

  async complete(prompt: SummaryPrompt): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(GROQ_CHAT_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
          response_format: { type: 'json_object' },
          // Low but not zero - a triage note read the same way twice in a row is more useful to a
          // doctor than one with a little more variety, but a hard-zero temperature is no more
          // "correct" here and some providers treat it as a special case worth avoiding.
          temperature: 0.2,
        }),
      });
    } catch (error) {
      // An aborted fetch keeps its own name so the caller can tell "timed out" apart from every
      // other failure - wrapping it here would erase that and every timeout would look generic.
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      throw new Error(`Could not reach Groq: ${describeUnknownError(error)}`, { cause: error });
    } finally {
      clearTimeout(timeout);
    }

    const body = (await response.json().catch(() => ({}))) as GroqChatResponse;
    if (!response.ok) {
      throw new Error(
        `Groq rejected the request (HTTP ${response.status}): ${body.error?.message ?? 'no message given'}`,
      );
    }

    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('Groq answered with no message content.');
    }
    return content;
  }
}
