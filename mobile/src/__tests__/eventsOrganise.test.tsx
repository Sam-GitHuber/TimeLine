/**
 * Events — the organiser's *set* surface (Phase 9 E3c-a).
 *
 * Pins the write paths this milestone adds: planning an event (create → open
 * it), the chip Set/Change → the dimension editor → **finalise** (a built-in
 * value written directly — date via the native picker, location via text), and
 * cancel/delete behind a confirm. Plus the two gates: the Set affordance shows
 * only for the organiser (`can_manage`), cancel/delete only for a moderator
 * (`can_moderate`).
 *
 * The native date picker is stubbed in `jest.setup.js` to fire `onChange` with a
 * fixed date (2026-08-15) when pressed, so "the organiser picked a value" is
 * deterministic. The poll builder is E3c-b and isn't exercised here.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { api, ApiError } from '@/api';
import EventScreen from '@/app/events/[eventId]';
import GroupScreen from '@/app/groups/[groupId]';
import { AuthProvider } from '@/auth';
import PlanEventScreen from '@/app/groups/[groupId]/plan';
import { PlanEventForm } from '@/components/events/PlanEventForm';
import { saveTokens } from '@/tokens';
import type { Event, Group, User } from '@/types';

import {
  alertSpy,
  androidIt,
  captureBackHandler,
  menuOptions,
  pickMenuAction,
  pickDateTimeValue,
  pressAlertButton,
  pressBack,
  resetMenuSpies,
} from './helpers';

/**
 * The date-picker stub's test controls (see `jest.setup.js`).
 *
 * On Android, presenting the picker is a *side effect* — the real component
 * renders nothing — so "was it opened, and how many times" can't be read off
 * the tree. These expose it, plus a way to arm the failure mode that fires
 * `onError` and nothing else.
 */
const pickerStub = jest.requireMock('@react-native-community/datetimepicker') as {
  __failNextOpen: () => void;
  __openCount: () => number;
};

const mockParams: Record<string, string> = { eventId: '9', groupId: '7' };
const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  // The screen is always focused under test, so focus is a plain effect — see
  // `jest.setup.js`, whose global stub this local factory overrides.
  useFocusEffect: (callback: () => void | (() => void)) =>
    // `require`, not an import: the factory is hoisted above the imports.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('react').useEffect(callback, [callback]),
  useLocalSearchParams: () => mockParams,
  // The event screen holds iOS's swipe-back while a write is out (#256); there
  // is no navigator under test and no gesture Node can perform. Same stand-in
  // as `jest.setup.js`, whose global stub this factory overrides.
  useNavigation: () => ({ setOptions: () => {} }),
  // Arrows read the spies lazily (the factory runs before the consts init).
  router: {
    push: (...a: unknown[]) => mockPush(...a),
    replace: (...a: unknown[]) => mockReplace(...a),
    back: (...a: unknown[]) => mockBack(...a),
    canGoBack: () => true,
  },
}));

const mockFetch = jest.fn();
function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === null ? '' : JSON.stringify(body)),
    json: async () => body,
  };
}

const ME: User = {
  pk: 1,
  email: 'me@example.com',
  first_name: 'Me',
  last_name: 'Myself',
  display_name: 'Me Myself',
  bio: '',
  avatar_url: null,
  avatar_thumb: null,
  is_staff: false,
  send_read_receipts: true,
};

const GROUP: Group = {
  id: 7,
  name: 'The Andersons',
  description: 'Family group',
  avatar_url: null,
  avatar_thumb: null,
  member_count: 4,
  your_role: 'member',
  created_at: '2026-07-01T10:00:00Z',
};

// A blank-slate event: nothing decided, no polls — so every built-in chip is
// `unset` and (for the organiser) shows "Set".
function planningEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: 9,
    group: { id: 7, name: 'The Andersons' },
    organiser: { id: 1, display_name: 'Me Myself', avatar_thumb: null },
    title: 'Summer camping weekend',
    description: '',
    event_date: null,
    start_time: null,
    end_time: null,
    timezone: 'Europe/London',
    location_name: '',
    location_url: '',
    location_note: '',
    status: 'planning',
    is_past: false,
    starts_at: null,
    dimensions: {
      date: { state: 'unset', poll: null },
      time: { state: 'unset', poll: null },
      location: { state: 'unset', poll: null },
    },
    rsvp: {
      counts: { going: 0, maybe: 0, declined: 0, guests: 0 },
      your_response: null,
      going_list: [],
      maybe_list: [],
      declined_list: [],
    },
    can_manage: true,
    can_moderate: true,
    reactions: [],
    comment_count: 0,
    new_comment_count: 0,
    photos: [],
    photo_count: 0,
    created_at: '2026-07-18T10:00:00Z',
    updated_at: '2026-07-18T10:00:00Z',
    polls: [],
    ...overrides,
  };
}

function serveEvent(event: Event) {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes('/api/auth/user/')) return jsonResponse(ME);
    if (url.includes('/api/events/9/')) return jsonResponse(event);
    return jsonResponse(null, 404);
  });
}

async function renderWith(node: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } },
  });
  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{node}</AuthProvider>
      </QueryClientProvider>
    );
  });
  // Returned so a test can force a background refetch — the ordinary way this
  // screen re-renders without the organiser doing anything (#169).
  return queryClient;
}

beforeEach(async () => {
  mockFetch.mockReset();
  resetMenuSpies();
  mockPush.mockReset();
  mockReplace.mockReset();
  mockBack.mockReset();
  mockParams.eventId = '9';
  mockParams.groupId = '7';
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  await saveTokens({ access: 'a', refresh: 'r' });
});

afterEach(async () => {
  cleanup();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

// --- Plan an event ---------------------------------------------------------

describe('PlanEventForm', () => {
  it('creates an event from a title and opens it', async () => {
    const create = jest
      .spyOn(api, 'createEvent')
      .mockResolvedValue(planningEvent({ id: 42 }));

    await renderWith(<PlanEventForm groupId={7} />);

    await fireEvent.changeText(
      screen.getByLabelText('What are you planning?'),
      'Grandma’s 80th'
    );
    await fireEvent.press(screen.getByText('Plan an event'));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(7, { title: 'Grandma’s 80th', description: '' })
    );
    // Straight to the new event, replacing (not pushing) so Back → the group.
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/events/42'));
    create.mockRestore();
  });

  it('won’t submit an empty title', async () => {
    const create = jest.spyOn(api, 'createEvent');
    await renderWith(<PlanEventForm groupId={7} />);

    await fireEvent.press(screen.getByText('Plan an event'));

    expect(create).not.toHaveBeenCalled();
    create.mockRestore();
  });

  /**
   * Nothing leaves the screen while the POST is out (#259).
   *
   * There is no Cancel on this form — the ways out are the screen's "← Back",
   * Android's hardware back and iOS's swipe — and the error above the button is
   * its only renderer. Planning an event is a thing you do *once*, so "did that
   * work?" isn't a question you get a second look at: you find out when nobody
   * turns up.
   */
  describe('holding the screen while the event is being created', () => {
    async function startCreating() {
      let refuse: (error: Error) => void = () => {};
      const create = jest.spyOn(api, 'createEvent').mockReturnValue(
        new Promise((_resolve, reject) => {
          refuse = reject;
        }) as ReturnType<typeof api.createEvent>
      );
      await renderWith(<PlanEventScreen />);
      await fireEvent.changeText(
        screen.getByLabelText('What are you planning?'),
        'Grandma’s 80th'
      );
      await act(async () => {
        // By role: the screen's title says "Plan an event" too.
        fireEvent.press(screen.getByRole('button', { name: 'Plan an event' }));
      });
      expect(await screen.findByText('Planning…')).toBeTruthy();
      return {
        create,
        refuse: async (message: string) => {
          await act(async () => {
            // DRF's shape for a 400 — see the note in `groupForm.test.tsx`:
            // only a `fromServer` rejection puts the server's words on screen.
            refuse(new ApiError(message, 400, { detail: message }));
            await new Promise((resolve) => setTimeout(resolve, 0));
          });
        },
      };
    }

    it('refuses the screen’s Back, then shows the refusal', async () => {
      const server = await startCreating();

      await fireEvent.press(screen.getByLabelText('Back'));
      expect(mockBack).not.toHaveBeenCalled();

      await server.refuse('You’re no longer in this group.');
      expect(
        await screen.findByText('You’re no longer in this group.')
      ).toBeTruthy();
      server.create.mockRestore();
    });

    androidIt('refuses hardware back, then shows the refusal', async () => {
      captureBackHandler();
      const server = await startCreating();

      await act(async () => {
        // Claimed, not passed on: falling through would pop the screen.
        expect(pressBack()).toBe(true);
      });

      await server.refuse('You’re no longer in this group.');
      expect(
        await screen.findByText('You’re no longer in this group.')
      ).toBeTruthy();
      server.create.mockRestore();
    });
  });
});

// --- Set a dimension (finalise) --------------------------------------------

describe('setting a dimension', () => {
  it('finalises a date the organiser picks', async () => {
    serveEvent(planningEvent());
    const finalise = jest
      .spyOn(api, 'finaliseDimension')
      .mockResolvedValue(planningEvent());

    await renderWith(<EventScreen />);

    // Open the date editor, "pick" a value (the stub fires 2026-08-15), commit.
    await fireEvent.press(await screen.findByLabelText('Set Date'));
    await pickDateTimeValue('date');
    await fireEvent.press(screen.getByText('Set the date'));

    await waitFor(() =>
      expect(finalise).toHaveBeenCalledWith(9, { dimension: 'date', value: '2026-08-15' })
    );
    finalise.mockRestore();
  });

  /**
   * The Android bug this milestone exists for (Phase 10).
   *
   * Android's picker is a one-shot modal dialog: mounted, it opens once and is
   * inert thereafter. The editor therefore mounts it only while it should be
   * up and unmounts on dismissal, so the next press gets a working instance.
   * Get that wrong and the picker opens exactly once per visit to the screen —
   * which is invisible to a test that only ever opens it.
   */
  (Platform.OS === 'android' ? it : it.skip)(
    'reopens the picker after it is dismissed',
    async () => {
      serveEvent(planningEvent());

      await renderWith(<EventScreen />);
      await fireEvent.press(await screen.findByLabelText('Set Date'));

      // Closed to begin with: the editor shows its trigger, not a dialog.
      expect(screen.queryByLabelText('Pick a value')).toBeNull();

      await fireEvent.press(screen.getByLabelText('Choose a date'));
      expect(screen.getByLabelText('Pick a value')).toBeTruthy();

      // Dismiss (Android's Cancel) — the picker unmounts…
      await fireEvent.press(screen.getByLabelText('Dismiss the picker'));
      expect(screen.queryByLabelText('Pick a value')).toBeNull();

      // …and pressing the trigger again brings it back. This is the assertion
      // that would have failed before the fix.
      await fireEvent.press(screen.getByLabelText('Choose a date'));
      expect(screen.getByLabelText('Pick a value')).toBeTruthy();
    }
  );

  /**
   * A re-render underneath the open dialog must not disturb it (#169).
   *
   * The library re-presents the Android dialog from a `useEffect` keyed partly
   * on its callback props, so inline-arrow handlers re-opened it on *every*
   * render — snapping the calendar back to the seed and throwing away what the
   * organiser had spun to. The trigger is a background refetch here, but
   * anything that re-renders the screen did it, and the organiser did none of
   * them.
   */
  androidIt('keeps the in-progress date when the screen refetches underneath', async () => {
    serveEvent(planningEvent());
    const queryClient = await renderWith(<EventScreen />);

    await fireEvent.press(await screen.findByLabelText('Set Date'));
    await fireEvent.press(screen.getByLabelText('Choose a date'));

    // The organiser spins the calendar a day past the seeded value.
    await fireEvent.press(screen.getByLabelText('Spin the picker'));
    expect(screen.getByLabelText('Picker selection').props.children).toBe('1');

    // A background refetch lands. It has to bring *changed* data to be worth
    // testing: react-query shares structure, so a byte-identical refetch keeps
    // the old object and never re-renders anything. `updated_at` moving is the
    // most inert change the event has.
    serveEvent(planningEvent({ updated_at: '2026-07-18T11:00:00Z' }));
    await act(async () => {
      await queryClient.invalidateQueries();
      // react-query notifies observers on a batched timer, so the re-render
      // this test is about lands *after* the refetch promise settles. Without
      // this tick the assertions below run before the screen has re-rendered
      // and pass no matter what.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Still the same presentation, still holding their selection.
    expect(pickerStub.__openCount()).toBe(1);
    expect(screen.getByLabelText('Picker selection').props.children).toBe('1');

    // And it's their spun value that gets committed, not the seed.
    await fireEvent.press(screen.getByLabelText('Pick a value'));
    const finalise = jest.spyOn(api, 'finaliseDimension').mockResolvedValue(planningEvent());
    await fireEvent.press(screen.getByText('Set the date'));
    await waitFor(() =>
      expect(finalise).toHaveBeenCalledWith(9, { dimension: 'date', value: '2026-08-16' })
    );
    finalise.mockRestore();
  });

  /**
   * An open that throws must not wedge the editor (#170).
   *
   * `DateTimePickerAndroid.open` presents inside a `try`/`catch` whose only
   * exit is `onError` — a null host activity reports through neither OK nor
   * Cancel. With the "is it up" flag left `true` and a trigger that only ever
   * set it `true`, the editor was dead for the rest of the visit, and "Set the
   * date" would then commit whatever `new Date()` had seeded it with.
   */
  androidIt('recovers from a picker that fails to open', async () => {
    serveEvent(planningEvent());
    await renderWith(<EventScreen />);

    await fireEvent.press(await screen.findByLabelText('Set Date'));

    pickerStub.__failNextOpen();
    await fireEvent.press(screen.getByLabelText('Choose a date'));

    // It was attempted, and nothing came up.
    expect(pickerStub.__openCount()).toBe(1);
    expect(screen.queryByLabelText('Pick a value')).toBeNull();

    // The next press must still present one. Before the fix this was a no-op
    // against a flag already `true`, and the editor never recovered.
    await fireEvent.press(screen.getByLabelText('Choose a date'));
    expect(screen.getByLabelText('Pick a value')).toBeTruthy();
  });

  /**
   * The cost of remounting on every press, which #170's fix introduced.
   *
   * Tearing down a presentation makes the library dismiss its dialog, and that
   * resolves its still-pending `open` as a **Cancel** — reported late, through
   * the handlers that presentation captured. So a second tap before the first
   * dialog has finished appearing (a couple of hundred ms on cheap hardware —
   * an ordinary double-tap) opens a second one, then hears the first one's
   * Cancel and closes it. The organiser sees the calendar flash up and vanish.
   */
  androidIt('survives a double-tap on the trigger', async () => {
    serveEvent(planningEvent());
    await renderWith(<EventScreen />);

    await fireEvent.press(await screen.findByLabelText('Set Date'));

    await fireEvent.press(screen.getByLabelText('Choose a date'));
    await fireEvent.press(screen.getByLabelText('Choose a date'));

    // Let the superseded presentation's Cancel land.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Two presentations were asked for, and the one the organiser is actually
    // looking at is still up.
    expect(pickerStub.__openCount()).toBe(2);
    expect(screen.getByLabelText('Pick a value')).toBeTruthy();
  });

  it('finalises a typed location', async () => {
    serveEvent(planningEvent());
    const finalise = jest
      .spyOn(api, 'finaliseDimension')
      .mockResolvedValue(planningEvent());

    await renderWith(<EventScreen />);

    await fireEvent.press(await screen.findByLabelText('Set Where'));
    await fireEvent.changeText(screen.getByLabelText('Set the place'), 'The Oakhouse');
    await fireEvent.press(screen.getByText('Set the place'));

    await waitFor(() =>
      expect(finalise).toHaveBeenCalledWith(9, { dimension: 'location', value: 'The Oakhouse' })
    );
    finalise.mockRestore();
  });

  it('offers Change on an already-set chip and opens its editor', async () => {
    // A date-decided event: the date chip is `set`, so the organiser sees Change.
    serveEvent(
      planningEvent({
        event_date: '2026-08-15',
        dimensions: {
          date: { state: 'set', poll: null },
          time: { state: 'unset', poll: null },
          location: { state: 'unset', poll: null },
        },
      })
    );

    await renderWith(<EventScreen />);

    await fireEvent.press(await screen.findByLabelText('Change Date'));
    // The editor opened. What proves that differs by platform, and the
    // difference is the feature: iOS mounts the wheel inline, Android shows a
    // trigger and only raises its one-shot dialog when you press it.
    expect(
      await screen.findByLabelText(
        Platform.OS === 'android' ? 'Choose a date' : 'Pick a value'
      )
    ).toBeTruthy();
  });

  it('surfaces a finalise failure in an alert and keeps the editor open', async () => {
    serveEvent(planningEvent());
    const finalise = jest
      .spyOn(api, 'finaliseDimension')
      .mockRejectedValue(new ApiError('That date has already passed.', 400, null));

    await renderWith(<EventScreen />);

    await fireEvent.press(await screen.findByLabelText('Set Date'));
    await pickDateTimeValue('date');
    await fireEvent.press(screen.getByText('Set the date'));

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith('Couldn’t save', 'That date has already passed.')
    );
    // The editor stays open on error so the organiser can retry.
    expect(screen.getByText('Set the date')).toBeTruthy();
    finalise.mockRestore();
  });

  // The same write, rejected by something that wrote no sentence for a person —
  // a bare runtime `Error` (offline is React Native's `TypeError`, a 500 behind
  // Caddy is HTML). This alert used to read `err.message`, so it put the raw
  // runtime string on screen; `serverMessage` keeps ours (#237, and the rule in
  // connections.md#reporting-a-refused-write).
  it('falls back to our own words when the rejection wrote none', async () => {
    serveEvent(planningEvent());
    const finalise = jest
      .spyOn(api, 'finaliseDimension')
      .mockRejectedValue(new TypeError('Network request failed'));

    await renderWith(<EventScreen />);

    await fireEvent.press(await screen.findByLabelText('Set Date'));
    await pickDateTimeValue('date');
    await fireEvent.press(screen.getByText('Set the date'));

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(
        'Couldn’t save',
        'Something went wrong — try again in a moment.'
      )
    );
    finalise.mockRestore();
  });

  /**
   * Android back closes the dimension editor, not the event (#168).
   *
   * The editor opens inline under the chip rather than as a Modal, so an
   * unclaimed press took the organiser off the event entirely — mid-decision,
   * and back to the group timeline.
   */
  androidIt('closes the dimension editor on Android back', async () => {
    captureBackHandler();
    serveEvent(planningEvent());
    const finalise = jest.spyOn(api, 'finaliseDimension');

    await renderWith(<EventScreen />);
    await fireEvent.press(await screen.findByLabelText('Set Date'));
    await screen.findByText('Set the date');

    await act(async () => {
      expect(pressBack()).toBe(true);
    });

    // The editor is gone, the chip that opens it is back, and nothing was
    // committed on the way out.
    expect(screen.queryByText('Set the date')).toBeNull();
    expect(screen.getByLabelText('Set Date')).toBeTruthy();
    expect(finalise).not.toHaveBeenCalled();
    finalise.mockRestore();
  });

  it('offers no Set affordance to a non-organiser', async () => {
    serveEvent(planningEvent({ can_manage: false, can_moderate: false }));

    await renderWith(<EventScreen />);
    await screen.findByText('Summer camping weekend');

    expect(screen.queryByLabelText('Set Date')).toBeNull();
    // …and the read-only chip still shows its status.
    expect(screen.getAllByText('not set').length).toBeGreaterThan(0);
  });
});

// --- Cancel / delete -------------------------------------------------------

describe('cancel and delete', () => {
  it('cancels the event after a confirm (moderator only)', async () => {
    serveEvent(planningEvent());
    const cancel = jest.spyOn(api, 'cancelEvent').mockResolvedValue(planningEvent());

    await renderWith(<EventScreen />);

    await fireEvent.press(await screen.findByText('Manage event'));
    await fireEvent.press(await screen.findByText('Cancel event'));
    // The confirm Alert hands us its buttons; press the destructive one.
    await act(async () => pressAlertButton('Cancel this event?', 'Cancel event'));

    await waitFor(() => expect(cancel).toHaveBeenCalledWith(9));
    cancel.mockRestore();
  });

  it('deletes the event after a confirm (moderator only)', async () => {
    serveEvent(planningEvent());
    const del = jest.spyOn(api, 'deleteEvent').mockResolvedValue(undefined);

    await renderWith(<EventScreen />);

    await fireEvent.press(await screen.findByText('Manage event'));
    await fireEvent.press(await screen.findByText('Delete event'));
    // The confirm Alert hands us its buttons; press the destructive one.
    await act(async () => pressAlertButton('Delete this event?', 'Delete'));

    await waitFor(() => expect(del).toHaveBeenCalledWith(9));
    del.mockRestore();
  });

  // #237: neither write repaints anything except from `onSuccess`, so a refused
  // cancel was pixel-identical to one that worked — right down to the confirm
  // that promised everyone who RSVP'd would be told. Nobody is notified and the
  // organiser has no reason to doubt it; they find out when people turn up.
  it('says so when the cancel is refused', async () => {
    serveEvent(planningEvent());
    const cancel = jest
      .spyOn(api, 'cancelEvent')
      .mockRejectedValue(new ApiError('You can no longer manage this event.', 403, null));

    await renderWith(<EventScreen />);

    await fireEvent.press(await screen.findByText('Manage event'));
    await fireEvent.press(await screen.findByText('Cancel event'));
    await act(async () => pressAlertButton('Cancel this event?', 'Cancel event'));

    await waitFor(() => expect(cancel).toHaveBeenCalledWith(9));
    // The server's own sentence, not our fallback — it says more than we could.
    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(
        'Couldn’t cancel the event',
        'You can no longer manage this event.'
      )
    );
    cancel.mockRestore();
  });

  it('says so when the delete is refused, and stays on the event', async () => {
    serveEvent(planningEvent());
    // Offline: React Native rejects with a bare `TypeError`, which carries no
    // sentence worth showing — so this is the case the fallback exists for, and
    // the one a tester on patchy signal hits first.
    const del = jest
      .spyOn(api, 'deleteEvent')
      .mockRejectedValue(new TypeError('Network request failed'));

    await renderWith(<EventScreen />);

    await fireEvent.press(await screen.findByText('Manage event'));
    await fireEvent.press(await screen.findByText('Delete event'));
    await act(async () => pressAlertButton('Delete this event?', 'Delete'));

    await waitFor(() => expect(del).toHaveBeenCalledWith(9));
    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(
        'Couldn’t delete the event',
        'Something went wrong — try again in a moment.'
      )
    );
    // `goBack` runs from `onSuccess` only, so the event is still on screen —
    // which is exactly why it needed something to say.
    expect(screen.getByText('Summer camping weekend')).toBeTruthy();
    del.mockRestore();
  });

  it('hides cancel/delete from a non-moderator', async () => {
    serveEvent(planningEvent({ can_manage: false, can_moderate: false }));

    await renderWith(<EventScreen />);
    await screen.findByText('Summer camping weekend');

    expect(screen.queryByText('Manage event')).toBeNull();
    expect(screen.queryByText('Cancel event')).toBeNull();
    expect(screen.queryByText('Delete event')).toBeNull();
  });
});

// --- Add to my calendar (#418) ----------------------------------------------

describe('add to my calendar', () => {
  const calendar = jest.requireMock('expo-calendar/legacy') as {
    createEventInCalendarAsync: jest.Mock;
  };
  const scheduled = (overrides: Partial<Event> = {}) =>
    planningEvent({
      event_date: '2026-08-15',
      start_time: '19:00:00',
      starts_at: '2026-08-15T19:00:00+01:00',
      status: 'scheduled',
      location_name: 'The Barn',
      dimensions: {
        date: { state: 'set', poll: null },
        time: { state: 'set', poll: null },
        location: { state: 'set', poll: null },
      },
      ...overrides,
    });

  beforeEach(() => calendar.createEventInCalendarAsync.mockClear());

  it('opens the pre-filled New Event form', async () => {
    serveEvent(scheduled());

    await renderWith(<EventScreen />);
    await fireEvent.press(await screen.findByText('Add to my calendar'));

    await waitFor(() => expect(calendar.createEventInCalendarAsync).toHaveBeenCalledTimes(1));
    const details = calendar.createEventInCalendarAsync.mock.calls[0][0];
    expect(details).toMatchObject({
      title: 'Summer camping weekend',
      allDay: false,
      location: 'The Barn',
      timeZone: 'Europe/London',
    });
    expect(details.startDate.toISOString()).toBe('2026-08-15T18:00:00.000Z');
    // Settled and pressable again; keeps the last re-render inside the test.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add to my calendar' })).toBeEnabled()
    );
  });

  it('is offered to someone who can’t manage the event', async () => {
    serveEvent(scheduled({ can_manage: false, can_moderate: false, can_cancel: false }));

    await renderWith(<EventScreen />);

    expect(await screen.findByText('Add to my calendar')).toBeTruthy();
    expect(screen.queryByText('Manage event')).toBeNull();
  });

  it('isn’t offered while the event has no date', async () => {
    serveEvent(planningEvent());

    await renderWith(<EventScreen />);
    await screen.findByText('Summer camping weekend');

    expect(screen.queryByText('Add to my calendar')).toBeNull();
  });

  it('isn’t offered once the event is cancelled', async () => {
    // The form can only add a new entry, so there'd be nothing to mark off.
    serveEvent(scheduled({ status: 'cancelled' }));

    await renderWith(<EventScreen />);
    await screen.findByText('Summer camping weekend');

    expect(screen.queryByText('Add to my calendar')).toBeNull();
  });

  it('says so when the form can’t be shown', async () => {
    serveEvent(scheduled());
    calendar.createEventInCalendarAsync.mockRejectedValueOnce(new Error('E_DIALOG'));

    await renderWith(<EventScreen />);
    await fireEvent.press(await screen.findByText('Add to my calendar'));

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(
        'Couldn’t add it to your calendar',
        'Something went wrong — try again in a moment.'
      )
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add to my calendar' })).toBeEnabled()
    );
  });
});

// --- Co-organisers + the Manage sheet (#419) ----------------------------------

const BOB = { id: 2, display_name: 'Bob Baker', avatar_thumb: null };
const ANN = { id: 3, display_name: 'Ann Lee', avatar_thumb: null };

describe('co-organisers', () => {
  it('names the co-organisers on the organiser line', async () => {
    serveEvent(planningEvent({ co_organisers: [BOB, ANN] }));
    await renderWith(<EventScreen />);
    expect(
      await screen.findByText('Organised by Me Myself with Bob Baker and Ann Lee')
    ).toBeTruthy();
  });

  it('lets the organiser add someone from the server’s candidate list', async () => {
    serveEvent(planningEvent({ is_organiser: true, co_organisers: [] }));
    const candidates = jest.spyOn(api, 'coOrganiserCandidates').mockResolvedValue([BOB]);
    const add = jest
      .spyOn(api, 'addCoOrganiser')
      .mockResolvedValue(planningEvent({ is_organiser: true, co_organisers: [BOB] }));

    await renderWith(<EventScreen />);
    await fireEvent.press(await screen.findByText('Manage event'));
    expect(screen.getByText('No co-organisers yet.')).toBeTruthy();
    await fireEvent.press(screen.getByText('+ Add co-organiser'));
    await fireEvent.press(await screen.findByLabelText('Add Bob Baker'));

    await waitFor(() => expect(add).toHaveBeenCalledWith(9, 2));
    expect(candidates).toHaveBeenCalledWith(9);
    candidates.mockRestore();
    add.mockRestore();
  });

  it('says so when there is nobody the organiser could add', async () => {
    serveEvent(planningEvent({ is_organiser: true, co_organisers: [] }));
    const candidates = jest.spyOn(api, 'coOrganiserCandidates').mockResolvedValue([]);
    await renderWith(<EventScreen />);
    await fireEvent.press(await screen.findByText('Manage event'));
    await fireEvent.press(screen.getByText('+ Add co-organiser'));
    expect(await screen.findByText(/Nobody else to add/)).toBeTruthy();
    candidates.mockRestore();
  });

  it('lets the organiser remove one, and says so when that is refused', async () => {
    serveEvent(planningEvent({ is_organiser: true, co_organisers: [BOB] }));
    const remove = jest
      .spyOn(api, 'removeCoOrganiser')
      .mockRejectedValue(new ApiError('Not found.', 404, null));
    await renderWith(<EventScreen />);
    await fireEvent.press(await screen.findByText('Manage event'));
    await fireEvent.press(screen.getByLabelText('Remove Bob Baker'));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(9, 2));
    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith('Couldn’t remove them', 'Not found.')
    );
    remove.mockRestore();
  });

  it('gives a co-organiser cancel and step-down, but never delete or the picker', async () => {
    // Me (pk 1) co-organising Bob's event.
    serveEvent(
      planningEvent({
        organiser: BOB,
        is_organiser: false,
        can_manage: true,
        can_cancel: true,
        can_moderate: false,
        co_organisers: [{ id: 1, display_name: 'Me Myself', avatar_thumb: null }],
      })
    );
    const remove = jest.spyOn(api, 'removeCoOrganiser').mockResolvedValue(planningEvent());
    await renderWith(<EventScreen />);
    await fireEvent.press(await screen.findByText('Manage event'));

    expect(screen.getByText('Cancel event')).toBeTruthy();
    expect(screen.queryByText('Delete event')).toBeNull();
    expect(screen.queryByText('+ Add co-organiser')).toBeNull();
    expect(screen.queryByLabelText('Remove Me Myself')).toBeNull();

    await fireEvent.press(screen.getByText('Step down as co-organiser'));
    await act(async () => pressAlertButton('Step down as co-organiser?', 'Step down'));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(9, 1));
    remove.mockRestore();
  });

  it('gives a group admin who isn’t organising just cancel and delete', async () => {
    serveEvent(
      planningEvent({
        organiser: BOB,
        is_organiser: false,
        can_manage: false,
        can_cancel: true,
        can_moderate: true,
      })
    );
    await renderWith(<EventScreen />);
    await fireEvent.press(await screen.findByText('Manage event'));
    expect(screen.getByText('Cancel event')).toBeTruthy();
    expect(screen.getByText('Delete event')).toBeTruthy();
    expect(screen.queryByText('Co-organisers')).toBeNull();
  });

  it('falls back to can_moderate for cancel against an older server', async () => {
    // No can_cancel / is_organiser / co_organisers on the payload at all.
    serveEvent(planningEvent());
    await renderWith(<EventScreen />);
    await fireEvent.press(await screen.findByText('Manage event'));
    expect(screen.getByText('Cancel event')).toBeTruthy();
    expect(screen.getByText('Delete event')).toBeTruthy();
    // `can_manage` there still means "the organiser", so they mustn't be
    // offered a step-down from an event they run.
    expect(screen.queryByText('Step down as co-organiser')).toBeNull();
    expect(screen.queryByText('Co-organisers')).toBeNull();
  });

  it('holds the Manage button while a cancel is in flight', async () => {
    serveEvent(planningEvent({ is_organiser: true }));
    let finish: (e: Event) => void = () => {};
    const cancel = jest
      .spyOn(api, 'cancelEvent')
      .mockImplementation(() => new Promise<Event>((r) => { finish = r; }));
    await renderWith(<EventScreen />);
    await fireEvent.press(await screen.findByText('Manage event'));
    await fireEvent.press(screen.getByText('Cancel event'));
    await act(async () => pressAlertButton('Cancel this event?', 'Cancel event'));
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));

    // Reopening the sheet to fire it again is exactly what must not work.
    // Asserted on the control's state: RNTL's `fireEvent` presses a disabled
    // Pressable regardless, so pressing it here would prove nothing.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Manage event' })).toBeDisabled()
    );
    expect(screen.queryByText('Cancel event')).toBeNull();

    await act(async () => finish(planningEvent()));
    cancel.mockRestore();
  });

  it('warns the organiser about RSVPs who can no longer see the event', async () => {
    serveEvent(planningEvent({ is_organiser: true, unreachable_rsvp_count: 2 }));
    await renderWith(<EventScreen />);
    expect(
      await screen.findByText(
        '2 people who replied can’t see this event any more — they aren’t connected to you.'
      )
    ).toBeTruthy();
  });
});

// --- Group menu: Plan an event ---------------------------------------------

describe('group ⋯ menu', () => {
  it('routes "Plan an event" to the plan screen', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/auth/user/')) return jsonResponse(ME);
      if (url.includes('/api/groups/7/posts/')) {
        return jsonResponse({ count: 0, next: null, previous: null, results: [] });
      }
      if (url.includes('/api/groups/7/events/')) return jsonResponse([]);
      if (url.includes('/api/groups/7/')) return jsonResponse(GROUP);
      return jsonResponse(null, 404);
    });

    await renderWith(<GroupScreen />);
    await fireEvent.press(await screen.findByLabelText('Group actions'));

    expect(menuOptions()[0]).toBe('Plan an event');
    await act(async () => pickMenuAction(0));

    expect(mockPush).toHaveBeenCalledWith('/groups/7/plan');
  });
});
