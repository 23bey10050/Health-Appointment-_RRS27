/**
 * The window doses are spread across. Not the full 24 hours - a patient asleep at 3 AM is not
 * going to take a pill then, and a naive "divide the day evenly starting at midnight" is exactly
 * the kind of date math that produces reminders nobody asked for at that hour.
 */
const WAKING_START_MINUTES = 8 * 60;
const WAKING_END_MINUTES = 20 * 60;
const SINGLE_DOSE_TIME = '09:00:00';

function asTimeString(minutesSinceMidnight: number): string {
  const hours = Math.floor(minutesSinceMidnight / 60)
    .toString()
    .padStart(2, '0');
  const minutes = (minutesSinceMidnight % 60).toString().padStart(2, '0');
  return `${hours}:${minutes}:00`;
}

/**
 * Turns "three times a day" into three clock times, evenly spread across the waking window rather
 * than the whole day. One dose a day gets a fixed mid-morning slot instead of the same spreading
 * logic - there is no "even spread" for a single point, and 9 AM is a reasonable default for
 * whenever a patient has not been told a specific time.
 */
export function timesOfDayFor(timesPerDay: number): string[] {
  if (timesPerDay <= 1) {
    return [SINGLE_DOSE_TIME];
  }

  const span = WAKING_END_MINUTES - WAKING_START_MINUTES;
  const times: string[] = [];
  for (let dose = 0; dose < timesPerDay; dose += 1) {
    const minutes = WAKING_START_MINUTES + Math.round((dose * span) / (timesPerDay - 1));
    times.push(asTimeString(minutes));
  }
  return times;
}
