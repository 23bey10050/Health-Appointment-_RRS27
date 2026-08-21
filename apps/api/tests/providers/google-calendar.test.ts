import { afterEach, describe, expect, it, vi } from 'vitest';

import { deleteCalendarEvent, insertCalendarEvent } from '../../src/providers/google-calendar.js';

const event = {
  id: 'abc123',
  summary: 'Appointment with Dr Anand Mehta',
  description: 'Cardiology appointment.',
  start: new Date('2026-09-01T03:30:00.000Z'),
  end: new Date('2026-09-01T03:50:00.000Z'),
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('insertCalendarEvent', () => {
  it('sends the exact event shape Google Calendar documents, with a bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: event.id }));
    vi.stubGlobal('fetch', fetchMock);

    const eventId = await insertCalendarEvent('an-access-token', event);

    expect(eventId).toBe('abc123');
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    expect(options.method).toBe('POST');
    expect(options.headers).toMatchObject({ Authorization: 'Bearer an-access-token' });
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: 'abc123',
      summary: event.summary,
      description: event.description,
      start: { dateTime: '2026-09-01T03:30:00.000Z' },
      end: { dateTime: '2026-09-01T03:50:00.000Z' },
    });
  });

  it('treats a 409 - the id already exists - as success, not a failure to retry', async () => {
    // Exactly the retry scenario this whole thing exists for: the first attempt actually
    // succeeded server-side, but its response never made it back before the outbox row timed out.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 409 })));

    await expect(insertCalendarEvent('an-access-token', event)).resolves.toBe('abc123');
  });

  it('throws a clear error for a genuine rejection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(403, { error: { message: 'Insufficient permission' } })),
    );

    await expect(insertCalendarEvent('an-access-token', event)).rejects.toThrow(
      /HTTP 403.*Insufficient permission/,
    );
  });
});

describe('deleteCalendarEvent', () => {
  it('sends a DELETE with a bearer token to the event-specific URL', async () => {
    // A 204 response is defined to carry no body at all - passing null, not an empty string, is
    // what the Fetch spec (and Node's own implementation of it) actually requires here.
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await deleteCalendarEvent('an-access-token', 'abc123');

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events/abc123');
    expect(options.method).toBe('DELETE');
    expect(options.headers).toMatchObject({ Authorization: 'Bearer an-access-token' });
  });

  it('treats a 404 - already gone - as success, not a failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));

    await expect(deleteCalendarEvent('an-access-token', 'abc123')).resolves.toBeUndefined();
  });

  it('treats a 410 - gone - as success too', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 410 })));

    await expect(deleteCalendarEvent('an-access-token', 'abc123')).resolves.toBeUndefined();
  });

  it('throws a clear error for a genuine rejection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(401, { error: { message: 'Invalid credentials' } })),
    );

    await expect(deleteCalendarEvent('an-access-token', 'abc123')).rejects.toThrow(
      /HTTP 401.*Invalid credentials/,
    );
  });
});
