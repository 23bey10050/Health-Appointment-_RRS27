/** The browser's own guess at the visitor's timezone - the same IANA identifier the API stores
 *  for a signed-up user, so a slot always reads in whichever zone the person viewing it is
 *  actually in, matching how every email this app sends already renders times. */
export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function formatDateTime(iso: string, timezone = browserTimezone()): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function formatDate(iso: string, timezone = browserTimezone()): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date(iso));
}

export function formatTime(iso: string, timezone = browserTimezone()): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** "2026-09-01", in a given timezone - what a day-picker or a grouped-by-day slot list keys on. */
export function localDateKey(iso: string, timezone = browserTimezone()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(iso));
}

/** Whole seconds remaining until a deadline, floored at zero - what the hold countdown ticks
 *  down from a `setInterval`, recomputed from the real clock each time rather than decremented by
 *  hand, so a backgrounded tab does not drift out of sync with the server's own expiry. */
export function secondsUntil(iso: string): number {
  return Math.max(0, Math.floor((new Date(iso).getTime() - Date.now()) / 1000));
}

export function formatCountdown(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
