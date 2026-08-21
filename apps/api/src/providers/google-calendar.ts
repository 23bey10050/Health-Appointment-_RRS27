import { describeUnknownError } from '../shared/errors.js';

const EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const REQUEST_TIMEOUT_MS = 8000;

export interface CalendarEventInput {
  /** A stable, deterministic id derived from the appointment - see `eventIdFor` in
   *  `modules/calendar/sync.ts` - not a random one. Retrying an insert with the same id after a
   *  network blip lost the first response hits Google's own "already exists" conflict instead of
   *  silently creating a second event, which is the actual idempotency guarantee here. */
  id: string;
  summary: string;
  description: string;
  start: Date;
  end: Date;
}

interface GoogleErrorBody {
  error?: { code?: number; message?: string };
}

function eventBody(event: CalendarEventInput): Record<string, unknown> {
  return {
    id: event.id,
    summary: event.summary,
    description: event.description,
    // A plain ISO instant already carries its own UTC offset, so `timeZone` is not strictly
    // required here - it is included anyway because Google's own docs recommend always setting
    // it, and each attendee's calendar renders the event in their own timezone regardless.
    start: { dateTime: event.start.toISOString(), timeZone: 'UTC' },
    end: { dateTime: event.end.toISOString(), timeZone: 'UTC' },
  };
}

async function callCalendarApi(
  url: string,
  method: 'POST' | 'DELETE',
  accessToken: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw error;
    }
    throw new Error(`Could not reach Google Calendar: ${describeUnknownError(error)}`, {
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Creates one event in a user's primary calendar, or - on a retry that lands after an earlier
 * attempt actually succeeded server-side - recognizes the resulting 409 and treats it as the same
 * success rather than a failure. Returns the event's id either way, since with a deterministic
 * input id that value was already known before the call was even made.
 */
export async function insertCalendarEvent(
  accessToken: string,
  event: CalendarEventInput,
): Promise<string> {
  const response = await callCalendarApi(EVENTS_URL, 'POST', accessToken, eventBody(event));
  if (response.ok || response.status === 409) {
    return event.id;
  }

  const body = (await response.json().catch(() => ({}))) as GoogleErrorBody;
  throw new Error(
    `Google Calendar rejected the event (HTTP ${response.status}): ${body.error?.message ?? 'no message given'}`,
  );
}

/** Deletes an event. A 404 or 410 - already gone, whether from an earlier successful delete or
 *  because the user removed it themselves - is treated as success, not a failure to retry. */
export async function deleteCalendarEvent(accessToken: string, eventId: string): Promise<void> {
  const response = await callCalendarApi(`${EVENTS_URL}/${eventId}`, 'DELETE', accessToken);
  if (response.ok || response.status === 404 || response.status === 410) {
    return;
  }

  const body = (await response.json().catch(() => ({}))) as GoogleErrorBody;
  throw new Error(
    `Google Calendar rejected the delete (HTTP ${response.status}): ${body.error?.message ?? 'no message given'}`,
  );
}
