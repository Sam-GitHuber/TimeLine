/**
 * "Add to my calendar" (#418) — the OS's own pre-filled **New Event** form.
 *
 * On iOS that's EventKit's editor, presented over the app; the person checks
 * the details, picks a calendar and taps Add, and never leaves TimeLine. On
 * Android it's the calendar app's insert screen (`ACTION_INSERT`) — there's no
 * in-process equivalent there — and Back or Save returns here.
 *
 * Why the form and not the server's `.ics` (which the web uses): handing a file
 * to the system meant opening Safari, i.e. leaving the app, and the browser
 * can't send our bearer token anyway. The cost is that a form-made entry shares
 * no ID with the `.ics`, so adding it twice gives two entries and a later cancel
 * can't update it — which is why a cancelled event doesn't offer the button.
 *
 * **Permissions.** `createEventInCalendarAsync` comes from `expo-calendar/legacy`
 * on purpose: on **iOS 17+** it needs no calendar permission at all (the editor
 * runs out of process and only the person can save from it), whereas the newer
 * class API's `addEventWithForm` needs a calendar object, which can't be had
 * without full access. Only **iOS 16** (the app supports 16.4+) asks, once.
 * **Android** needs nothing: an intent, so the module's READ/WRITE_CALENDAR are
 * blocked in `app.json`.
 *
 * **Privacy.** The details leave the app into whichever calendar the person
 * saves to (iCloud, Google…), by their own tap, for an event they can already
 * see. Nobody's name goes with it — no organiser, no attendees, the same rule
 * as the `.ics` (events.md).
 */

import { Platform } from 'react-native';
import {
  createEventInCalendarAsync,
  getCalendarPermissionsAsync,
  requestCalendarPermissionsAsync,
} from 'expo-calendar/legacy';

import { BASE_URL } from '@/api';
import { parseEventDate } from '@/eventFormat';
import type { Event } from '@/types';

/** What the form is pre-filled with — the subset of expo-calendar's `Event`. */
export type CalendarFormDetails = {
  title: string;
  startDate: Date;
  endDate: Date;
  allDay: boolean;
  timeZone?: string;
  location?: string;
  notes: string;
  url: string;
};

type Exportable = Pick<
  Event,
  | 'id'
  | 'group'
  | 'title'
  | 'description'
  | 'event_date'
  | 'start_time'
  | 'end_time'
  | 'timezone'
  | 'starts_at'
  | 'location_name'
  | 'location_url'
  | 'location_note'
>;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function minutesOf(time: string): number | null {
  const [h, m] = time.split(':').map(Number);
  return Number.isNaN(h) ? null : h * 60 + (Number.isNaN(m) ? 0 : m);
}

/**
 * The form's details for a **dated** event, or `null` without a date.
 *
 * - **Timed:** starts at `starts_at` — the server's instant, so the phone and
 *   the web agree whatever zone the phone is in — and passes the event's own
 *   zone so the form shows it as organised. The end is the start plus the
 *   wall-clock span to `end_time`, read as past midnight when it's at or before
 *   the start (a 22:00–02:00 party). With no end time, **an hour** — Calendar's
 *   own default for a new event; unlike the `.ics` this is a form the person
 *   sees and can change before saving, so it isn't invented data.
 * - **All-day:** that calendar date, as an all-day entry.
 *
 * The link back is `BASE_URL` + the web route — in the form's URL field on
 * iOS, in the notes on Android (which has no such field). The site and the API share an
 * origin in production (in dev it points at the local Django, which is fine).
 */
export function calendarFormDetails(event: Exportable): CalendarFormDetails | null {
  if (!event.event_date) return null;
  const link = `${BASE_URL}/g/${event.group.id}/events/${event.id}`;
  const notes = [
    event.description.trim(),
    event.location_note.trim(),
    event.location_url ? `Location: ${event.location_url}` : '',
    // iOS's form has a URL field of its own, which shows the link; Android's
    // insert screen has none, so there the notes are the only place for it.
    Platform.OS === 'ios' ? '' : `On TimeLine: ${link}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const base = {
    title: event.title,
    location: event.location_name.trim() || undefined,
    notes,
    url: link,
  };

  if (!event.start_time || !event.starts_at) {
    const day = parseEventDate(event.event_date);
    if (!day) return null;
    return { ...base, startDate: day, endDate: day, allDay: true };
  }

  const start = new Date(event.starts_at);
  const from = minutesOf(event.start_time);
  const to = event.end_time ? minutesOf(event.end_time) : null;
  let span = HOUR_MS;
  if (from !== null && to !== null && to !== from) {
    span = (to - from) * 60 * 1000;
    if (span < 0) span += DAY_MS;
  }
  return {
    ...base,
    startDate: start,
    endDate: new Date(start.getTime() + span),
    allDay: false,
    timeZone: event.timezone || undefined,
  };
}

/** Thrown when an iOS 16 phone has said no to calendar access. */
export class CalendarAccessDenied extends Error {
  constructor() {
    super(
      'TimeLine isn’t allowed to add to your calendar. You can turn it on in Settings → TimeLine → Calendars.'
    );
    this.name = 'CalendarAccessDenied';
  }
}

/** iOS before 17 is the only place the form needs permission first. */
function needsPermission(): boolean {
  if (Platform.OS !== 'ios') return false;
  const major = parseInt(String(Platform.Version), 10);
  return Number.isFinite(major) && major < 17;
}

/**
 * Present the pre-filled form. Resolves when it's dismissed, whatever the
 * person chose (saved or not — the form is theirs to cancel). Rejects with
 * `CalendarAccessDenied` on an iOS 16 phone that has refused access.
 */
export async function addEventToCalendar(event: Exportable): Promise<void> {
  const details = calendarFormDetails(event);
  if (!details) return;
  if (needsPermission()) {
    const current = await getCalendarPermissionsAsync();
    const granted = current.granted || (await requestCalendarPermissionsAsync()).granted;
    if (!granted) throw new CalendarAccessDenied();
  }
  await createEventInCalendarAsync(details);
}
