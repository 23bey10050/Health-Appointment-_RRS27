import type { AppConfig } from '../../config/env.js';
import type { Database } from '../../db/client.js';
import { deleteCalendarEvent, insertCalendarEvent } from '../../providers/google-calendar.js';
import type { GoogleOAuthConfig } from '../../providers/google-oauth.js';

import { getValidAccessToken } from './tokens.js';

export type CalendarSide = 'patient' | 'doctor';

export interface CalendarEventDetails {
  appointmentId: string;
  summary: string;
  description: string;
  start: Date;
  end: Date;
}

/**
 * The one thing the outbox worker needs from Google Calendar, kept narrow on purpose so a test
 * can hand the worker a fake instead of ever making a real network call.
 */
export interface CalendarSync {
  /** Creates, or on a retry recognizes, one person's own copy of an appointment event. Returns
   *  undefined - not an error - when that person has never connected Google Calendar. */
  upsertEvent(userId: string, event: CalendarEventDetails): Promise<string | undefined>;
  /** Deletes an event. A no-op, not an error, when the user was never connected. */
  deleteEvent(userId: string, eventId: string): Promise<void>;
}

/** Same id reused for both the patient's and the doctor's copy of one appointment - they live in
 *  two different people's calendars, so there is no collision, and a stable id derived from the
 *  appointment itself is what makes a retried create idempotent: Google's own "this id already
 *  exists" response on the second attempt is treated as success, not a duplicate. Hyphens are
 *  stripped because Google restricts custom event ids to lowercase base32hex characters, and a
 *  UUID's hex digits already satisfy that once the hyphens are gone. */
export function eventIdFor(appointmentId: string): string {
  return appointmentId.replace(/-/g, '');
}

/** Talks to a real Google account. Every call first asks `tokens.ts` for a valid access token,
 *  which is also where "never connected" (undefined) and "connected, but access was revoked"
 *  (a thrown error) are told apart - this class does not need its own opinion about either case. */
export class GoogleCalendarSync implements CalendarSync {
  constructor(
    private readonly database: Database,
    private readonly oauthConfig: GoogleOAuthConfig,
    private readonly encryptionKey: string,
  ) {}

  async upsertEvent(userId: string, event: CalendarEventDetails): Promise<string | undefined> {
    const accessToken = await getValidAccessToken(
      this.database,
      this.oauthConfig,
      userId,
      this.encryptionKey,
    );
    if (!accessToken) {
      return undefined;
    }
    return insertCalendarEvent(accessToken, {
      id: eventIdFor(event.appointmentId),
      summary: event.summary,
      description: event.description,
      start: event.start,
      end: event.end,
    });
  }

  async deleteEvent(userId: string, eventId: string): Promise<void> {
    const accessToken = await getValidAccessToken(
      this.database,
      this.oauthConfig,
      userId,
      this.encryptionKey,
    );
    if (!accessToken) {
      return;
    }
    await deleteCalendarEvent(accessToken, eventId);
  }
}

/** What every appointment gets when Google Calendar sync is not configured at all - the same
 *  "no event, silently" outcome an individually-unconnected user already produces, so a booking
 *  or cancellation behaves identically whether nobody has ever set up Google or everybody has and
 *  simply hasn't connected their own account yet. */
export class NoopCalendarSync implements CalendarSync {
  upsertEvent(): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }

  deleteEvent(): Promise<void> {
    return Promise.resolve();
  }
}

export function buildCalendarSync(database: Database, config: AppConfig): CalendarSync {
  const { google } = config;
  if (!google.clientId || !google.clientSecret || !google.redirectUri || !google.tokenEncryptionKey) {
    return new NoopCalendarSync();
  }
  return new GoogleCalendarSync(
    database,
    { clientId: google.clientId, clientSecret: google.clientSecret, redirectUri: google.redirectUri },
    google.tokenEncryptionKey,
  );
}
