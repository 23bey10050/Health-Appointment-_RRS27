import { describe, expect, it } from 'vitest';

import { parseTimeRange, serializeTimeRange, slotOf } from '../src/db/types/time-range.js';

describe('slotOf', () => {
  it('builds a range that ends after the given number of minutes', () => {
    const slot = slotOf(new Date('2026-09-01T10:00:00.000Z'), 20);

    expect(slot.start.toISOString()).toBe('2026-09-01T10:00:00.000Z');
    expect(slot.end.toISOString()).toBe('2026-09-01T10:20:00.000Z');
  });

  it('refuses a slot with no length', () => {
    expect(() => slotOf(new Date('2026-09-01T10:00:00.000Z'), 0)).toThrow(RangeError);
    expect(() => slotOf(new Date('2026-09-01T10:00:00.000Z'), -15)).toThrow(RangeError);
  });

  it('crosses a day boundary without any special handling', () => {
    const slot = slotOf(new Date('2026-09-01T23:50:00.000Z'), 30);

    expect(slot.end.toISOString()).toBe('2026-09-02T00:20:00.000Z');
  });
});

describe('serializeTimeRange', () => {
  it('writes a half-open range, so touching slots do not collide', () => {
    const written = serializeTimeRange(slotOf(new Date('2026-09-01T10:00:00.000Z'), 20));

    // The closing bracket is the part that matters. A ']' here would make 10:20 belong to both
    // slots, and every back-to-back appointment would be rejected as an overlap.
    expect(written).toBe('[2026-09-01T10:00:00.000Z,2026-09-01T10:20:00.000Z)');
  });

  it('refuses a range that ends before it starts', () => {
    expect(() =>
      serializeTimeRange({
        start: new Date('2026-09-01T10:20:00.000Z'),
        end: new Date('2026-09-01T10:00:00.000Z'),
      }),
    ).toThrow(RangeError);
  });

  it('refuses a zero-length range', () => {
    const instant = new Date('2026-09-01T10:00:00.000Z');

    expect(() => serializeTimeRange({ start: instant, end: instant })).toThrow(RangeError);
  });

  it('refuses an invalid date instead of writing "Invalid Date" into the database', () => {
    expect(() =>
      serializeTimeRange({
        start: new Date('not a date'),
        end: new Date('2026-09-01T10:00:00.000Z'),
      }),
    ).toThrow(TypeError);
  });

  it('refuses something that is not a Date at all', () => {
    expect(() =>
      serializeTimeRange({ start: '2026-09-01' as unknown as Date, end: new Date() }),
    ).toThrow(TypeError);
  });
});

describe('parseTimeRange', () => {
  it('reads back what Postgres actually sends, quotes and all', () => {
    const parsed = parseTimeRange('["2026-09-01 10:00:00+00","2026-09-01 10:20:00+00")');

    expect(parsed.start.toISOString()).toBe('2026-09-01T10:00:00.000Z');
    expect(parsed.end.toISOString()).toBe('2026-09-01T10:20:00.000Z');
  });

  it('survives a round trip', () => {
    const original = slotOf(new Date('2026-12-25T08:45:00.000Z'), 45);
    const parsed = parseTimeRange(serializeTimeRange(original));

    expect(parsed.start.getTime()).toBe(original.start.getTime());
    expect(parsed.end.getTime()).toBe(original.end.getTime());
  });

  it('complains loudly about a range it cannot read', () => {
    expect(() => parseTimeRange('empty')).toThrow(TypeError);
    expect(() => parseTimeRange('')).toThrow(TypeError);
  });

  it('rejects a closed range, because our slots are never written that way', () => {
    expect(() => parseTimeRange('["2026-09-01 10:00:00+00","2026-09-01 10:20:00+00"]')).toThrow(
      TypeError,
    );
  });

  it('rejects a range whose dates are nonsense', () => {
    expect(() => parseTimeRange('[not-a-date,also-not-a-date)')).toThrow(TypeError);
  });
});
