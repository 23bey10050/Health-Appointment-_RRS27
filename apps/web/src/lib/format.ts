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

/**
 * Renders a bare calendar date like "2026-09-01" as "Tuesday, September 1" - forced to UTC on
 * purpose, unlike `formatDate` above. A string like this has no time of day attached to convert in
 * the first place, and reading it back through the visitor's own timezone could shift it onto the
 * wrong day for anyone west of UTC at certain hours.
 */
export function formatCalendarDate(dateString: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date(`${dateString}T00:00:00Z`));
}

/** "Today", as the same plain calendar-date string every day-picker in this app keys on. */
export function todayAsDateString(): string {
  return localDateKey(new Date().toISOString());
}

/** Adds (or, with a negative value, subtracts) whole days to a plain calendar date like
 *  "2026-09-01" - used for stepping a day-picker forward or back a day at a time, where there is
 *  no time-of-day or timezone left to worry about, just which date comes next. */
export function addDays(dateString: string, days: number): string {
  const date = new Date(`${dateString}T00:00:00`);
  date.setDate(date.getDate() + days);
  return new Intl.DateTimeFormat('en-CA').format(date);
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
