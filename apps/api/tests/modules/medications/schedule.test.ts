import { describe, expect, it } from 'vitest';

import { timesOfDayFor } from '../../../src/modules/medications/schedule.js';

describe('timesOfDayFor', () => {
  it('gives a single dose a fixed mid-morning time, not a spread of one', () => {
    expect(timesOfDayFor(1)).toEqual(['09:00:00']);
  });

  it('spreads two doses across the start and end of the waking window', () => {
    expect(timesOfDayFor(2)).toEqual(['08:00:00', '20:00:00']);
  });

  it('spreads three doses evenly, including the midpoint', () => {
    expect(timesOfDayFor(3)).toEqual(['08:00:00', '14:00:00', '20:00:00']);
  });

  it('spreads four doses evenly across the same window', () => {
    expect(timesOfDayFor(4)).toEqual(['08:00:00', '12:00:00', '16:00:00', '20:00:00']);
  });

  it('never produces a time before 08:00 or after 20:00, however many doses a day', () => {
    for (let dosesPerDay = 1; dosesPerDay <= 8; dosesPerDay += 1) {
      for (const time of timesOfDayFor(dosesPerDay)) {
        expect(time >= '08:00:00' && time <= '20:00:00').toBe(true);
      }
    }
  });

  it('always returns exactly as many times as doses requested', () => {
    for (let dosesPerDay = 1; dosesPerDay <= 6; dosesPerDay += 1) {
      expect(timesOfDayFor(dosesPerDay)).toHaveLength(dosesPerDay);
    }
  });
});
