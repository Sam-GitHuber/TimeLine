/**
 * The event date/time helpers (Phase 9 E3b) — the "voice of time" for events.
 *
 * The load-bearing case is `parseEventDate`: it must build a *local* Date from
 * the numeric parts, never `new Date("2026-07-19")` (UTC midnight, which slips a
 * day west of Greenwich). The rest is formatting from wall-clock values.
 */

import {
  formatEventDate,
  formatEventTime,
  formatEventTimeParts,
  formatEventWhen,
  parseEventDate,
} from '@/eventFormat';

describe('parseEventDate', () => {
  it('parses a YYYY-MM-DD string to a local midnight, not a UTC one', () => {
    const d = parseEventDate('2026-07-19');
    expect(d).not.toBeNull();
    // Local components — the whole point is these never slip a day by timezone.
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(6); // July, 0-indexed
    expect(d!.getDate()).toBe(19);
    expect(d!.getHours()).toBe(0);
  });

  it('returns null for empty or malformed input', () => {
    expect(parseEventDate(null)).toBeNull();
    expect(parseEventDate(undefined)).toBeNull();
    expect(parseEventDate('')).toBeNull();
    expect(parseEventDate('not-a-date')).toBeNull();
  });
});

describe('formatEventDate', () => {
  it('omits the year in the current year, includes it otherwise', () => {
    const now = new Date(2026, 6, 1);
    expect(formatEventDate('2026-07-19', now)).not.toMatch(/2026/);
    expect(formatEventDate('2027-01-05', now)).toMatch(/2027/);
  });

  it('is blank when there is no date', () => {
    expect(formatEventDate(null)).toBe('');
  });
});

describe('formatEventTime', () => {
  it('drops the minutes on the hour, keeps them otherwise', () => {
    expect(formatEventTime('19:00')).toBe('7pm');
    expect(formatEventTime('19:30')).toBe('7:30pm');
    expect(formatEventTime('09:05')).toBe('9:05am');
    expect(formatEventTime('00:00')).toBe('12am');
  });

  it('accepts an HH:MM:SS value (the API sends seconds)', () => {
    expect(formatEventTime('19:00:00')).toBe('7pm');
  });

  it('is blank when there is no time (an all-day event)', () => {
    expect(formatEventTime(null)).toBe('');
  });
});

describe('formatEventTimeParts', () => {
  it('splits the time from its meridiem, or is null when all-day', () => {
    expect(formatEventTimeParts('14:10')).toEqual({ time: '2:10', meridiem: 'pm' });
    expect(formatEventTimeParts(null)).toBeNull();
  });
});

describe('formatEventWhen', () => {
  it('joins date and time, dropping the time for an all-day event', () => {
    const now = new Date(2026, 6, 1);
    expect(formatEventWhen({ event_date: '2026-07-19', start_time: '19:00' }, now)).toBe(
      `${formatEventDate('2026-07-19', now)} · 7pm`
    );
    expect(formatEventWhen({ event_date: '2026-07-19', start_time: null }, now)).toBe(
      formatEventDate('2026-07-19', now)
    );
  });

  it('is blank with no date, even if a time is present', () => {
    expect(formatEventWhen({ event_date: null, start_time: '19:00' })).toBe('');
  });
});
