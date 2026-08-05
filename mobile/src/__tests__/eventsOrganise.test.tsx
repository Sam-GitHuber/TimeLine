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
jest.mock('expo-router', () => ({
  // The screen is always focused under test, so focus is a plain effect — see
  // `jest.setup.js`, whose global stub this local factory overrides.
  useFocusEffect: (callback: () => void | (() => void)) =>
    // `require`, not an import: the factory is hoisted above the imports.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('react').useEffect(callback, [callback]),
  useLocalSearchParams: () => mockParams,
  // Arrows read the spies lazily (the factory runs before the consts init).
  router: {
    push: (...a: unknown[]) => mockPush(...a),
    replace: (...a: unknown[]) => mockReplace(...a),
    back: jest.fn(),
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

    expect(screen.queryByText('Cancel event')).toBeNull();
    expect(screen.queryByText('Delete event')).toBeNull();
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
