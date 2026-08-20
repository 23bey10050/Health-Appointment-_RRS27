import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrevoEmailSender } from '../../src/providers/brevo.js';
import type { EmailMessage } from '../../src/shared/email.js';

const message: EmailMessage = {
  to: { email: 'asha@example.test', name: 'Asha Verma' },
  subject: 'Your appointment is confirmed',
  html: '<p>hi</p>',
  text: 'hi',
  idempotencyKey: 'outbox-row-id-123',
};

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

describe('BrevoEmailSender', () => {
  it('sends the exact request shape Brevo documents', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { messageId: '<abc@relay>' }));
    vi.stubGlobal('fetch', fetchMock);
    const sender = new BrevoEmailSender(
      'the-api-key',
      'noreply@clinic.test',
      'Health Appointment Clinic',
    );

    await sender.send(message);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(options.method).toBe('POST');
    expect(options.headers).toMatchObject({
      'api-key': 'the-api-key',
      'Content-Type': 'application/json',
    });

    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      sender: { email: 'noreply@clinic.test', name: 'Health Appointment Clinic' },
      to: [{ email: 'asha@example.test', name: 'Asha Verma' }],
      subject: message.subject,
      htmlContent: message.html,
      textContent: message.text,
      headers: { 'Idempotency-Key': 'outbox-row-id-123' },
    });
  });

  it('treats a duplicate_parameter response as success, not a failure to retry', async () => {
    // Brevo's documented behaviour for a repeated idempotency key within its 30-minute window -
    // the message was already handled, so this must not be treated as an error worth backing off.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(400, {
          code: 'duplicate_parameter',
          message: 'This idempotencyKey has already been used.',
        }),
      ),
    );
    const sender = new BrevoEmailSender('key', 'noreply@clinic.test', 'Clinic');

    await expect(sender.send(message)).resolves.toBeUndefined();
  });

  it('throws a clear error for a genuine rejection, naming the code and message', async () => {
    // A fresh Response each call - a Response body can only be read once, and mockResolvedValue
    // would otherwise hand back the same already-consumed one on a second send.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(jsonResponse(401, { code: 'unauthorized', message: 'Key not found' })),
      ),
    );
    const sender = new BrevoEmailSender('bad-key', 'noreply@clinic.test', 'Clinic');

    await expect(sender.send(message)).rejects.toThrow(/HTTP 401.*unauthorized.*Key not found/s);
  });

  it('wraps a network failure instead of leaking the raw fetch error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const sender = new BrevoEmailSender('key', 'noreply@clinic.test', 'Clinic');

    await expect(sender.send(message)).rejects.toThrow(/Could not reach Brevo/);
  });

  it('handles a response body that is not valid JSON without crashing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('not json at all', { status: 500 })),
    );
    const sender = new BrevoEmailSender('key', 'noreply@clinic.test', 'Clinic');

    await expect(sender.send(message)).rejects.toThrow(/HTTP 500/);
  });
});
