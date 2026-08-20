import type { EmailMessage, EmailSender } from '../shared/email.js';
import { describeUnknownError } from '../shared/errors.js';

const BREVO_SEND_URL = 'https://api.brevo.com/v3/smtp/email';
const REQUEST_TIMEOUT_MS = 8000;

interface BrevoErrorBody {
  code?: string;
  message?: string;
}

/**
 * Talks to Brevo's transactional email API.
 *
 * The idempotency key is sent the way Brevo documents it — as an `Idempotency-Key` entry inside
 * the request body's own `headers` object, not as a genuine HTTP request header the way, say,
 * Stripe does it. Brevo remembers a key for 30 minutes and answers a repeat within that window
 * with a `duplicate_parameter` error rather than sending twice — that response is treated as a
 * success below, not a failure, because it means the message either already went out or is about
 * to. This whole contract was confirmed against Brevo's published API reference before writing a
 * line of it, the same way every raw SQL query earlier in this project was checked against a real
 * database first — but there is no live Brevo account behind this project yet, so the behaviour on
 * an actual send has not itself been observed, only documented.
 */
export class BrevoEmailSender implements EmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly senderEmail: string,
    private readonly senderName: string,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(BREVO_SEND_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'api-key': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sender: { email: this.senderEmail, name: this.senderName },
          to: [{ email: message.to.email, name: message.to.name }],
          subject: message.subject,
          htmlContent: message.html,
          textContent: message.text,
          headers: { 'Idempotency-Key': message.idempotencyKey },
        }),
      });
    } catch (error) {
      throw new Error(`Could not reach Brevo: ${describeUnknownError(error)}`, { cause: error });
    } finally {
      clearTimeout(timeout);
    }

    if (response.ok) {
      return;
    }

    const body = (await response.json().catch(() => ({}))) as BrevoErrorBody;

    if (body.code === 'duplicate_parameter') {
      // This exact idempotency key was already submitted within the last 30 minutes. The message
      // is already handled - sending it again would be the bug, not this response.
      return;
    }

    throw new Error(
      `Brevo rejected the email (HTTP ${response.status}, ${body.code ?? 'no code'}): ` +
        (body.message ?? 'no message given'),
    );
  }
}
