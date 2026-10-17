/**
 * "Add to my calendar" (#418) — what the OS's New Event form is pre-filled
 * with, and the one permission branch (iOS 16).
 *
 * Instants are asserted with `toISOString()` and all-day dates by their local
 * parts, never formatted strings: Jest here ignores a `TZ` set at runtime, so a
 * test must hold in whatever zone the runner happens to be in.
 */

import { Platform } from 'react-native';

import { BASE_URL } from '@/api';
import {
  addEventToCalendar,
  CalendarAccessDenied,
  calendarFormDetails,
} from '@/calendarExport';
import type { Event } from '@/types';

const calendar = jest.requireMock('expo-calendar/legacy') as {
  createEventInCalendarAsync: jest.Mock;
  getCalendarPermissionsAsync: jest.Mock;
  requestCalendarPermissionsAsync: jest.Mock;
};

type Exportable = Parameters<typeof calendarFormDetails>[0];

function event(overrides: Partial<Event> = {}): Exportable {
  return {
    id: 9,
    group: { id: 7, name: 'The Andersons' },
    title: 'Book club',
    description: '',
    event_date: '2026-08-15',
    start_time: '19:00:00',
    end_time: null,
    timezone: 'Europe/London',
    starts_at: '2026-08-15T19:00:00+01:00',
    location_name: '',
    location_url: '',
    location_note: '',
    ...overrides,
  };
}

const realOS = Platform.OS;

describe('calendarFormDetails', () => {
  afterEach(() => Object.defineProperty(Platform, 'OS', { value: realOS, configurable: true }));

  it('is nothing without a date', () => {
    expect(calendarFormDetails(event({ event_date: null, starts_at: null }))).toBeNull();
  });

  it('starts a timed event at the server’s instant, in the event’s zone', () => {
    const d = calendarFormDetails(event({ end_time: '21:30:00' }))!;
    expect(d.allDay).toBe(false);
    expect(d.startDate.toISOString()).toBe('2026-08-15T18:00:00.000Z');
    expect(d.endDate.toISOString()).toBe('2026-08-15T20:30:00.000Z');
    expect(d.timeZone).toBe('Europe/London');
  });

  it('runs an end at or before the start past midnight', () => {
    const d = calendarFormDetails(
      event({ start_time: '22:00:00', end_time: '02:00:00', starts_at: '2026-08-15T22:00:00Z' })
    )!;
    expect(d.endDate.toISOString()).toBe('2026-08-16T02:00:00.000Z');
  });

  it('pre-fills an hour when there is no end (or it equals the start)', () => {
    for (const end_time of [null, '19:00:00']) {
      const d = calendarFormDetails(event({ end_time }))!;
      expect(d.endDate.getTime() - d.startDate.getTime()).toBe(60 * 60 * 1000);
    }
  });

  it('makes a date-only event all-day on that calendar date', () => {
    const d = calendarFormDetails(event({ start_time: null, starts_at: '2026-08-15T00:00:00+01:00' }))!;
    expect(d.allDay).toBe(true);
    expect([d.startDate.getFullYear(), d.startDate.getMonth(), d.startDate.getDate()]).toEqual([
      2026, 7, 15,
    ]);
    expect(d.timeZone).toBeUndefined();
  });

  it('puts the details with no field of their own in the notes, and links back', () => {
    // Android: no URL field on its insert screen, so the link goes in the notes.
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    const link = `${BASE_URL}/g/7/events/9`;
    const d = calendarFormDetails(
      event({
        description: '  Bring the book  ',
        location_name: ' The Barn ',
        location_note: 'Round the back',
        location_url: 'https://maps.example/barn',
      })
    )!;
    expect(d.location).toBe('The Barn');
    expect(d.url).toBe(link);
    expect(d.notes).toBe(
      `Bring the book\n\nRound the back\n\nLocation: https://maps.example/barn\n\nOn TimeLine: ${link}`
    );
  });

  it('leaves location out when there isn’t one', () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    expect(calendarFormDetails(event())!.location).toBeUndefined();
    expect(calendarFormDetails(event())!.notes).toBe(`On TimeLine: ${BASE_URL}/g/7/events/9`);
  });

  it('on iOS links back once, in the URL field, not again in the notes', () => {
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    const d = calendarFormDetails(event({ description: 'Bring the book' }))!;
    expect(d.url).toBe(`${BASE_URL}/g/7/events/9`);
    expect(d.notes).toBe('Bring the book');
  });
});

describe('addEventToCalendar', () => {
  const realVersion = Platform.Version;

  function setPlatform(os: 'ios' | 'android', version: string | number) {
    Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
    Object.defineProperty(Platform, 'Version', { value: version, configurable: true });
  }

  beforeEach(() => {
    calendar.createEventInCalendarAsync.mockClear();
    calendar.getCalendarPermissionsAsync.mockClear();
    calendar.requestCalendarPermissionsAsync.mockClear();
  });
  afterEach(() => setPlatform(realOS as 'ios' | 'android', realVersion));

  it('asks for nothing on iOS 17+', async () => {
    setPlatform('ios', '17.5');
    await addEventToCalendar(event());
    expect(calendar.getCalendarPermissionsAsync).not.toHaveBeenCalled();
    expect(calendar.createEventInCalendarAsync).toHaveBeenCalledTimes(1);
  });

  it('asks for nothing on Android', async () => {
    setPlatform('android', 35);
    await addEventToCalendar(event());
    expect(calendar.getCalendarPermissionsAsync).not.toHaveBeenCalled();
    expect(calendar.createEventInCalendarAsync).toHaveBeenCalledTimes(1);
  });

  it('asks once on iOS 16, then opens the form', async () => {
    setPlatform('ios', '16.4');
    calendar.getCalendarPermissionsAsync.mockResolvedValueOnce({ granted: false, canAskAgain: true });
    await addEventToCalendar(event());
    expect(calendar.requestCalendarPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(calendar.createEventInCalendarAsync).toHaveBeenCalledTimes(1);
  });

  it('says so, and opens nothing, when iOS 16 refuses', async () => {
    setPlatform('ios', '16.4');
    calendar.getCalendarPermissionsAsync.mockResolvedValueOnce({ granted: false, canAskAgain: false });
    calendar.requestCalendarPermissionsAsync.mockResolvedValueOnce({ granted: false, canAskAgain: false });
    await expect(addEventToCalendar(event())).rejects.toBeInstanceOf(CalendarAccessDenied);
    expect(calendar.createEventInCalendarAsync).not.toHaveBeenCalled();
  });

  it('does nothing for an event without a date', async () => {
    await addEventToCalendar(event({ event_date: null, starts_at: null }));
    expect(calendar.createEventInCalendarAsync).not.toHaveBeenCalled();
  });
});
