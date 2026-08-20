import { describe, expect, it, vi } from 'vitest';

import { ConsoleEmailSender, type EmailMessage } from '../../src/shared/email.js';

const message: EmailMessage = {
  to: { email: 'asha@example.test', name: 'Asha Verma' },
  subject: 'Your appointment is confirmed',
  html: '<p>hi</p>',
  text: 'hi',
  idempotencyKey: 'outbox-row-id',
};

describe('ConsoleEmailSender', () => {
  it('logs the email instead of sending it, and never throws', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const sender = new ConsoleEmailSender(logger);

    await expect(sender.send(message)).resolves.toBeUndefined();

    expect(logger.info).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        to: message.to,
        subject: message.subject,
        idempotencyKey: message.idempotencyKey,
      }),
      expect.stringContaining('not configured'),
    );
  });

  it('logs the plain-text body, not the HTML, so it stays readable in a log line', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const sender = new ConsoleEmailSender(logger);

    await sender.send(message);

    const [details] = logger.info.mock.calls[0] as [Record<string, unknown>];
    expect(details['text']).toBe('hi');
    expect(details['html']).toBeUndefined();
  });
});
