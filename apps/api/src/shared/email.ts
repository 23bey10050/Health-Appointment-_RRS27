import type { Logger } from './logging.js';

export interface EmailRecipient {
  email: string;
  name: string;
}

export interface EmailMessage {
  to: EmailRecipient;
  subject: string;
  html: string;
  text: string;
  /**
   * A stable value that never changes between retries of the same logical send. Used so a network
   * blip that loses the response but not the request cannot turn into a second email landing in
   * someone's inbox — the outbox worker always passes the outbox row's own id here.
   */
  idempotencyKey: string;
}

/**
 * Two implementations exist from day one: `BrevoEmailSender` for a real account, and
 * `ConsoleEmailSender` for when there is not one yet. The interface is only worth having because
 * both are genuinely used — the project runs, and is fully demoable, on the console sender alone.
 */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/**
 * Prints the email instead of sending it. This is what makes the whole booking-to-notification
 * flow buildable and testable before a Brevo account exists, and it is the sender this project
 * actually runs on until `BREVO_API_KEY` is set in `.env`.
 */
export class ConsoleEmailSender implements EmailSender {
  constructor(private readonly logger: Logger) {}

  send(message: EmailMessage): Promise<void> {
    this.logger.info(
      {
        to: message.to,
        subject: message.subject,
        idempotencyKey: message.idempotencyKey,
        text: message.text,
      },
      'Email sender not configured — printing instead of sending',
    );
    return Promise.resolve();
  }
}
