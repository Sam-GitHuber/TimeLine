/**
 * Events on mobile (Phase 9 E3b) — the view + participate half.
 *
 * The load-bearing wiring is the *participate* path: RSVP and poll voting must
 * write through to the right endpoints with the right bodies (an RSVP upsert; a
 * vote as your *full* option selection). The detail screen also has to render an
 * event it can see and 404 gracefully one it can't. Alongside: the personal
 * Calendar tab, and the group page's upcoming section + past-events-in-timeline.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';

import { api, ApiError } from '@/api';
import EventScreen from '@/app/events/[eventId]';
import CalendarScreen from '@/app/(tabs)/calendar';
import GroupScreen from '@/app/groups/[groupId]';
import { AuthProvider } from '@/auth';
import { EventTimelineEntry } from '@/components/events/EventTimelineEntry';
import { MonthGrid } from '@/components/events/MonthGrid';
import { formatEventDate, formatEventTime } from '@/eventFormat';
import { saveTokens } from '@/tokens';
import type { Event, Group, Poll, User } from '@/types';

import {
  alertSpy,
  androidIt,
  captureBackHandler,
  choosePhotoSource,
  holdRequest,
  pressAlertButton,
  pressBack,
  resetMenuSpies,
  resetTray,
  settle,
  trayDismissed,
  trayHolds,
} from './helpers';

// The album's "Add photos" goes through the shared picker, which opens the
// camera-or-library menu and then a native module that doesn't exist under Node.
jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
}));

const pickFromLibrary = ImagePicker.launchImageLibraryAsync as jest.Mock;

const mockParams: Record<string, string> = { eventId: '9', groupId: '7' };
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
  router: {
    push: jest.fn(),
    back: jest.fn(),
    replace: jest.fn(),
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

const DATE_POLL: Poll = {
  id: 3,
  event: 9,
  dimension: 'date',
  question: 'Which weekend works?',
  allow_multiple: false,
  status: 'open',
  closes_at: null,
  created_at: '2026-07-18T10:00:00Z',
  options: [
    {
      id: 30,
      label: 'Sat 25 Jul',
      date_value: '2026-07-25',
      time_value: null,
      text_value: null,
      order: 0,
      count: 2,
      voters: [{ id: 2, display_name: 'Ada Lovelace', avatar_thumb: null }],
      you_voted: false,
    },
    {
      id: 31,
      label: 'Sun 26 Jul',
      date_value: '2026-07-26',
      time_value: null,
      text_value: null,
      order: 1,
      count: 0,
      voters: [],
      you_voted: false,
    },
  ],
  vote_count: 2,
  your_votes: [],
  decided_option: null,
};

// A custom poll whose option labels are plain text (not a formatted date). The
// vote path is dimension-agnostic, and a date option's *rendered* label goes
// through `toLocaleDateString`, which orders day/month differently by locale
// (en-GB "Sun 26 Jul" vs en-US "Sun, Jul 26") — so asserting on it is brittle
// across machines/CI. Plain-text labels keep the vote test locale-independent.
const CUSTOM_POLL: Poll = {
  id: 4,
  event: 9,
  dimension: 'custom',
  question: 'What should we bring?',
  allow_multiple: false,
  status: 'open',
  closes_at: null,
  created_at: '2026-07-18T10:00:00Z',
  options: [
    {
      id: 40,
      label: 'Snacks',
      date_value: null,
      time_value: null,
      text_value: 'Snacks',
      order: 0,
      count: 1,
      voters: [],
      you_voted: false,
    },
    {
      id: 41,
      label: 'Drinks',
      date_value: null,
      time_value: null,
      text_value: 'Drinks',
      order: 1,
      count: 0,
      voters: [],
      you_voted: false,
    },
  ],
  vote_count: 1,
  your_votes: [],
  decided_option: null,
};

// A second plain-text poll you've *already* voted in, so a test can watch one
// poll's ticks move while the tap happens in the other — which is what a vote
// cast on the web with this screen open looks like from here.
const PLACE_POLL: Poll = {
  id: 5,
  event: 9,
  dimension: 'location',
  question: 'Where should we meet?',
  allow_multiple: false,
  status: 'open',
  closes_at: null,
  created_at: '2026-07-18T10:00:00Z',
  options: [
    {
      id: 50,
      label: 'The park',
      date_value: null,
      time_value: null,
      text_value: 'The park',
      order: 0,
      count: 1,
      voters: [],
      you_voted: true,
    },
    {
      id: 51,
      label: 'The pub',
      date_value: null,
      time_value: null,
      text_value: 'The pub',
      order: 1,
      count: 0,
      voters: [],
      you_voted: false,
    },
  ],
  vote_count: 1,
  your_votes: [50],
  decided_option: null,
};

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: 9,
    group: { id: 7, name: 'The Andersons' },
    organiser: { id: 2, display_name: 'Ada Lovelace', avatar_thumb: null },
    title: 'Summer camping weekend',
    description: 'Bring a tent.',
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
      date: { state: 'polling', poll: 3 },
      time: { state: 'unset', poll: null },
      location: { state: 'unset', poll: null },
    },
    rsvp: {
      counts: { going: 1, maybe: 0, declined: 0, guests: 0 },
      your_response: null,
      going_list: [],
      maybe_list: [],
      declined_list: [],
    },
    can_manage: false,
    can_moderate: false,
    reactions: [],
    comment_count: 0,
    new_comment_count: 0,
    photos: [],
    photo_count: 0,
    created_at: '2026-07-18T10:00:00Z',
    updated_at: '2026-07-18T10:00:00Z',
    polls: [DATE_POLL],
    ...overrides,
  };
}

// `await render(...)`: under React 19's concurrent root the initial commit lands
// in a microtask, so an unawaited render leaves `screen` unpopulated (the shared
// helper pattern the other suites use — see people.test / groupDetail.test).
async function renderWith(
  node: React.ReactElement,
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  })
) {
  // The client comes back so a test can drive a refetch and read the query's
  // state afterwards; callers that don't care can keep ignoring it.
  const view = await render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{node}</AuthProvider>
    </QueryClientProvider>
  );
  return { client: queryClient, ...view };
}

beforeEach(async () => {
  mockFetch.mockReset();
  mockParams.eventId = '9';
  mockParams.groupId = '7';
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  (router.push as jest.Mock).mockClear();
  resetMenuSpies();
  pickFromLibrary.mockReset().mockResolvedValue({ canceled: true });
  await saveTokens({ access: 'a', refresh: 'r' });
});

// --- Event detail (view) ---------------------------------------------------

describe('event detail', () => {
  it('renders the event, its poll, and the RSVP control', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/auth/user/')) return jsonResponse(ME);
      if (url.includes('/api/events/9/')) return jsonResponse(makeEvent());
      return jsonResponse(null, 404);
    });

    await renderWith(<EventScreen />);

    expect(await screen.findByText('Summer camping weekend')).toBeTruthy();
    expect(screen.getByText('Organised by Ada Lovelace')).toBeTruthy();
    expect(screen.getByText('Which weekend works?')).toBeTruthy();
    // The RSVP control offers the three responses.
    expect(screen.getByRole('button', { name: /Going/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Can't go/ })).toBeTruthy();
  });

  it('renders a tappable link for a safe http(s) location url', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/auth/user/')) return jsonResponse(ME);
      if (url.includes('/api/events/9/'))
        return jsonResponse(
          makeEvent({ location_name: 'The park', location_url: 'https://maps.example.com/park' })
        );
      return jsonResponse(null, 404);
    });

    await renderWith(<EventScreen />);
    await screen.findByText(/The park/);

    expect(screen.getByRole('link')).toBeTruthy();
  });

  it('drops the link for a non-http(s) location url (no unsafe scheme)', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/auth/user/')) return jsonResponse(ME);
      if (url.includes('/api/events/9/'))
        return jsonResponse(
          // An attacker-controlled value — any member can organise an event, and
          // `Linking.openURL` would fire *any* scheme, so a non-http(s) link must
          // not become a tappable affordance.
          makeEvent({ location_name: 'The park', location_url: 'javascript:alert(1)' })
        );
      return jsonResponse(null, 404);
    });

    await renderWith(<EventScreen />);
    await screen.findByText(/The park/);

    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows "not available" for an event you cannot see (a 404)', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/auth/user/')) return jsonResponse(ME);
      if (url.includes('/api/events/9/')) return jsonResponse(null, 404);
      return jsonResponse(null, 404);
    });

    await renderWith(<EventScreen />);

    expect(await screen.findByText('Event not available')).toBeTruthy();
  });

  /**
   * Viewing is seeing, mirrored on the request rather than on a render (#318) —
   * the post screen's twin, and it moves with it.
   */
  describe('seen-on-view', () => {
    /** A client whose seeded cache survives to the first render — see below. */
    function warmClient() {
      return new QueryClient({
        defaultOptions: {
          queries: { retry: false, gcTime: Infinity },
          mutations: { gcTime: 0 },
        },
      });
    }

    beforeEach(resetTray);
    // Not only `beforeEach`: jest.config sets no `restoreMocks`, and this
    // describe sits mid-file with fifty `EventScreen` tests after it, every one
    // of which would otherwise run against the last tray seeded here.
    afterEach(resetTray);

    it('refreshes the unread count and clears the tray once the event lands', async () => {
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes('/api/auth/user/')) return jsonResponse(ME);
        if (url.includes('/api/events/9/')) return jsonResponse(makeEvent());
        return jsonResponse(null, 404);
      });
      trayHolds(
        { identifier: 'mine', url: '/g/7/events/9?comment=3' },
        { identifier: 'someone-else', url: '/g/7/events/10' }
      );
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } },
      });
      const invalidate = jest.spyOn(client, 'invalidateQueries');

      await renderWith(<EventScreen />, client);
      await screen.findByText('Summer camping weekend');

      await waitFor(() =>
        expect(invalidate).toHaveBeenCalledWith({ queryKey: ['notificationsUnread'] })
      );
      await waitFor(() => expect(trayDismissed()).toEqual(['mine']));
    });

    it('sweeps the tray again on a later fetch, not only on the first', async () => {
      // The server stamps seen on every one of these GETs, so a push that
      // arrives while the event is open must leave the tray with the refetch
      // that an RSVP, a vote or a foreground triggers. Once-per-mount left the
      // app's tray lagging its own backend.
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes('/api/auth/user/')) return jsonResponse(ME);
        if (url.includes('/api/events/9/')) return jsonResponse(makeEvent());
        return jsonResponse(null, 404);
      });
      const client = warmClient();

      await renderWith(<EventScreen />, client);
      await screen.findByText('Summer camping weekend');
      await waitFor(() => expect(trayDismissed()).toEqual([]));

      trayHolds({ identifier: 'arrived-later', url: '/g/7/events/9' });
      await act(async () => {
        await client.invalidateQueries({ queryKey: ['event', 9] });
      });

      await waitFor(() => expect(trayDismissed()).toEqual(['arrived-later']));
    });

    /**
     * #318, and the event's version is the sharper one: a cancelled event that
     * someone then deletes is exactly the case where the push is the only thing
     * that would explain where it went. `useQuery` returns the cached event
     * synchronously, so the old effect fired before the mount refetch had asked
     * the server anything, and the failure that followed left the screen
     * claiming the event was gone with the notification already dismissed.
     */
    it.each([
      [404, 'Event not available'],
      // A 503 says nothing about whether the event exists, so the screen keeps
      // the copy it has — but the dismissal is just as wrong, because the
      // server never stamped.
      [503, 'Summer camping weekend'],
    ])(
      'keeps the notification when a warm-cache reopen fails with a %i',
      async (status, expected) => {
        mockFetch.mockImplementation(async (url: string) => {
          if (url.includes('/api/auth/user/')) return jsonResponse(ME);
          return jsonResponse(null, status);
        });
        trayHolds({ identifier: 'mine', url: '/g/7/events/9' });
        // `gcTime: Infinity`: a seeded entry with nothing observing it is
        // collected before the render on this file's default, and a warm cache
        // is the whole scenario.
        const client = warmClient();
        client.setQueryData(['event', 9], makeEvent());
        const invalidate = jest.spyOn(client, 'invalidateQueries');

        await renderWith(<EventScreen />, client);

        expect(await screen.findByText(expected)).toBeTruthy();
        expect(trayDismissed()).toEqual([]);
        expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['notificationsUnread'] });
      }
    );
  });

  it('upserts your RSVP when you choose a response', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/auth/user/')) return jsonResponse(ME);
      if (url.includes('/api/events/9/')) return jsonResponse(makeEvent());
      return jsonResponse(null, 404);
    });
    const rsvp = jest.spyOn(api, 'rsvpEvent').mockResolvedValue(makeEvent());

    await renderWith(<EventScreen />);
    await screen.findByText('Summer camping weekend');

    await fireEvent.press(screen.getByRole('button', { name: /Going/ }));

    await waitFor(() =>
      expect(rsvp).toHaveBeenCalledWith(9, { response: 'going', guests: 0, note: '' })
    );
    rsvp.mockRestore();
  });

  it('casts your vote as the full option selection', async () => {
    // A custom poll — its option labels are plain text, so the query isn't
    // locale-dependent (see CUSTOM_POLL). The vote path is the same as a date
    // poll's.
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/auth/user/')) return jsonResponse(ME);
      if (url.includes('/api/events/9/')) return jsonResponse(makeEvent({ polls: [CUSTOM_POLL] }));
      return jsonResponse(null, 404);
    });
    const vote = jest.spyOn(api, 'votePoll').mockResolvedValue(CUSTOM_POLL);

    await renderWith(<EventScreen />);

    // Tap the second (unvoted) option — single-choice, so the full selection is
    // just that one id. `findByRole` waits for the poll to render (the question
    // text itself is ambiguous — it's also a DimensionChips label for the poll).
    await fireEvent.press(await screen.findByRole('button', { name: /Drinks/ }));

    await waitFor(() => expect(vote).toHaveBeenCalledWith(4, [41]));
    vote.mockRestore();
  });
});

// --- Optimistic ticks (#227) -----------------------------------------------

/**
 * Your tick appears the moment you tap, before the server has agreed — the web
 * fixed this in #216, and mobile is the client with the worse network. Both
 * halves of that debt: the tick comes back if the vote is rejected, and the
 * server's answer wins whenever it changes underneath us.
 */
describe('optimistic vote ticks', () => {
  // What the next fetch of the event returns. Reassign it to model data that
  // changed elsewhere — a vote cast on the web, or your own round-tripping.
  // A copy of a poll with your votes moved to `ids`. The per-option `you_voted`
  // flags move with them: the component reads only `your_votes`, but a fixture
  // whose two halves disagree would mislead the next person about which of them
  // drives the sync.
  function movedVotes(poll: Poll, ids: number[]): Poll {
    return {
      ...poll,
      your_votes: ids,
      options: poll.options.map((o) => ({ ...o, you_voted: ids.includes(o.id) })),
    };
  }

  let served: Event;
  function serveEvent(event: Event) {
    served = event;
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/auth/user/')) return jsonResponse(ME);
      if (url.includes('/api/events/9/')) return jsonResponse(served);
      return jsonResponse(null, 404);
    });
  }

  /**
   * Left showing, a dropped vote is invisible: the tally not moving reads as
   * "nobody else has voted yet" rather than "you never voted", so you believe
   * you answered and the organiser counts you as silent.
   */
  it('takes a failed vote’s tick back and says what happened', async () => {
    serveEvent(makeEvent({ polls: [CUSTOM_POLL] }));
    // A 409 — the organiser closed the poll moments before your tap. DRF's
    // `detail` reaches us as an ApiError, and it's written for a person.
    const vote = jest
      .spyOn(api, 'votePoll')
      .mockRejectedValue(new ApiError('This poll is closed.', 409, null));

    await renderWith(<EventScreen />);

    const drinks = await screen.findByRole('button', { name: /Drinks/ });
    expect(drinks).not.toBeSelected();
    await fireEvent.press(drinks);

    expect(await screen.findByText('This poll is closed.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Drinks/ })).not.toBeSelected();
    vote.mockRestore();
  });

  /**
   * The dominant mobile failure isn't a 409, it's no signal — and React Native
   * rejects that with `TypeError: Network request failed`. Rendering a rejection's
   * message blindly would put that string on the poll card, in exactly the case
   * this whole guard was built for.
   */
  it('shows plain copy, not a runtime string, when the tap finds no signal', async () => {
    serveEvent(makeEvent({ polls: [CUSTOM_POLL] }));
    const vote = jest
      .spyOn(api, 'votePoll')
      .mockRejectedValue(new TypeError('Network request failed'));

    await renderWith(<EventScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: /Drinks/ }));

    expect(await screen.findByText(/didn’t go through/)).toBeTruthy();
    expect(screen.queryByText(/Network request failed/)).toBeNull();
    expect(screen.getByRole('button', { name: /Drinks/ })).not.toBeSelected();
    vote.mockRestore();
  });

  /**
   * The other half: ticks were seeded once and then owned locally, so a vote
   * cast elsewhere never reached this copy of the screen — the counts refreshed
   * and the ticks didn't, and the card contradicted itself until it unmounted.
   */
  it('re-syncs your ticks when the server’s answer changes underneath', async () => {
    serveEvent(makeEvent({ polls: [PLACE_POLL, CUSTOM_POLL] }));
    // What the refetch carries: you moved your place vote on the web, and the
    // Drinks vote you're about to cast here has landed.
    const vote = jest.spyOn(api, 'votePoll').mockImplementation(async () => {
      serveEvent(
        makeEvent({
          polls: [movedVotes(PLACE_POLL, [51]), movedVotes(CUSTOM_POLL, [41])],
        })
      );
      return CUSTOM_POLL;
    });

    await renderWith(<EventScreen />);
    expect(await screen.findByRole('button', { name: /The park/ })).toBeSelected();

    // Voting in the *other* poll invalidates the event; the refetch brings the
    // place vote with it.
    await fireEvent.press(screen.getByRole('button', { name: /Drinks/ }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /The pub/ })).toBeSelected()
    );
    expect(screen.getByRole('button', { name: /The park/ })).not.toBeSelected();
    vote.mockRestore();
  });

  /**
   * The rollback undoes our own optimistic tick, not whatever the server has
   * said since: a vote arriving from another device while this request is in
   * flight is the newer truth, and a snapshot taken before the tap mustn't wipe
   * it.
   */
  it('doesn’t roll back over an answer the server gave mid-vote', async () => {
    serveEvent(makeEvent({ polls: [CUSTOM_POLL] }));
    // The Snacks vote fails, but only after a refetch — triggered by the RSVP —
    // has brought in a Drinks vote cast elsewhere.
    let rejectVote: (err: Error) => void = () => {};
    const vote = jest.spyOn(api, 'votePoll').mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectVote = reject;
        })
    );
    const rsvp = jest.spyOn(api, 'rsvpEvent').mockImplementation(async () => {
      serveEvent(makeEvent({ polls: [movedVotes(CUSTOM_POLL, [41])] }));
      return served;
    });

    await renderWith(<EventScreen />);

    // `act`, not `await fireEvent.press`: the press hands back `toggle`'s
    // promise, and this vote deliberately never settles until we reject it.
    const snacks = await screen.findByRole('button', { name: /Snacks/ });
    await act(async () => {
      fireEvent.press(snacks);
    });
    await waitFor(() => expect(vote).toHaveBeenCalledWith(4, [40]));
    expect(screen.getByRole('button', { name: /Snacks/ })).toBeSelected();

    await fireEvent.press(screen.getByRole('button', { name: /Going/ }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Drinks/ })).toBeSelected()
    );

    await act(async () => {
      rejectVote(new TypeError('Network request failed'));
    });

    // The failure is stated, and the newer vote survives it.
    expect(await screen.findByText(/didn’t go through/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Drinks/ })).toBeSelected();
    expect(screen.getByRole('button', { name: /Snacks/ })).not.toBeSelected();
    vote.mockRestore();
    rsvp.mockRestore();
  });

  /**
   * A message about an earlier attempt is out of date once the server says where
   * your votes stand — otherwise "your vote didn't go through" can sit under a
   * tick the server has since confirmed, which is its own small lie.
   */
  it('clears a stale failure once the server states your votes', async () => {
    serveEvent(makeEvent({ polls: [CUSTOM_POLL] }));
    const vote = jest
      .spyOn(api, 'votePoll')
      .mockRejectedValue(new ApiError('This poll is closed.', 409, null));
    const rsvp = jest.spyOn(api, 'rsvpEvent').mockImplementation(async () => {
      // The vote had in fact landed — only its response was lost.
      serveEvent(makeEvent({ polls: [movedVotes(CUSTOM_POLL, [41])] }));
      return served;
    });

    await renderWith(<EventScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: /Drinks/ }));
    expect(await screen.findByText('This poll is closed.')).toBeTruthy();

    // Anything that refetches the event carries the server's answer with it.
    await fireEvent.press(screen.getByRole('button', { name: /Going/ }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Drinks/ })).toBeSelected()
    );
    expect(screen.queryByText('This poll is closed.')).toBeNull();
    vote.mockRestore();
    rsvp.mockRestore();
  });

  /**
   * The clear is deliberately narrower than "the server said something": only the
   * server *arriving at the selection you cast* retires the message. A refetch
   * carrying some third answer is not confirmation, and swallowing the failure
   * there is the bug #231 reports — the message the whole guard exists to deliver,
   * lost in exactly the conditions (bad signal, concurrent refetch) that produced
   * the failure in the first place.
   */
  it('keeps the failure showing when the server moves to a different vote', async () => {
    serveEvent(makeEvent({ polls: [CUSTOM_POLL] }));
    const vote = jest
      .spyOn(api, 'votePoll')
      .mockRejectedValue(new ApiError('This poll is closed.', 409, null));
    const rsvp = jest.spyOn(api, 'rsvpEvent').mockImplementation(async () => {
      // Neither what we cast nor what the server held when we cast it: a Snacks
      // vote made on the web while this screen sat open.
      serveEvent(makeEvent({ polls: [movedVotes(CUSTOM_POLL, [40])] }));
      return served;
    });

    await renderWith(<EventScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: /Drinks/ }));
    expect(await screen.findByText('This poll is closed.')).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: /Going/ }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Snacks/ })).toBeSelected()
    );

    // Your vote still didn't land, so it still says so — even though the ticks
    // have moved on to the newer truth.
    expect(screen.getByText('This poll is closed.')).toBeTruthy();
    vote.mockRestore();
    rsvp.mockRestore();
  });

  /**
   * The exact shape #231 reports: the cache update and the rejection land in
   * **one** React batch, so the card renders once holding both the new failure
   * and the new `poll` prop. A clear that fired on the sync alone ran before the
   * message was ever painted, and nothing appeared at all.
   *
   * `setQueryData` rather than a held refetch: it is the same cache write the
   * refetch performs, and driving it directly is what makes "the same batch"
   * a fact of the test rather than a hope about scheduling.
   */
  it('keeps the failure showing when the cache update and the rejection share a batch', async () => {
    serveEvent(makeEvent({ polls: [CUSTOM_POLL] }));
    let rejectVote: (err: Error) => void = () => {};
    const vote = jest.spyOn(api, 'votePoll').mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectVote = reject;
        })
    );

    const { client } = await renderWith(<EventScreen />);

    // `act`, not `await fireEvent.press`: the press hands back `toggle`'s
    // promise, and this vote deliberately never settles until we reject it.
    const drinks = await screen.findByRole('button', { name: /Drinks/ });
    await act(async () => {
      fireEvent.press(drinks);
    });
    await waitFor(() => expect(vote).toHaveBeenCalledWith(4, [41]));

    await act(async () => {
      client.setQueryData(['event', 9], makeEvent({ polls: [movedVotes(CUSTOM_POLL, [40])] }));
      rejectVote(new TypeError('Network request failed'));
    });

    expect(screen.getByText(/didn’t go through/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Snacks/ })).toBeSelected();
    vote.mockRestore();
  });

  /**
   * Casting exactly what the server already shows is reachable in the window
   * between a vote landing and its refetch catching up: your tick is a step ahead
   * of `your_votes`, so tapping it again sends the server its own answer back. So
   * "the server is confirming the attempt" can't be judged on the selection
   * alone — without also remembering what the server said *before* the attempt,
   * this failure would be cleared the instant it was set.
   */
  it('still says so when the rejected vote changed nothing', async () => {
    // The server hasn't caught up: every refetch still reports no vote of yours,
    // so `your_votes` never moves off empty.
    serveEvent(makeEvent({ polls: [CUSTOM_POLL] }));
    const vote = jest
      .spyOn(api, 'votePoll')
      .mockResolvedValueOnce(CUSTOM_POLL)
      .mockRejectedValueOnce(new ApiError('This poll is closed.', 409, null));

    await renderWith(<EventScreen />);

    // Tick Drinks. It lands, so the tally is a step ahead of the server.
    await fireEvent.press(await screen.findByRole('button', { name: /Drinks/ }));
    await waitFor(() => expect(vote).toHaveBeenCalledTimes(1));
    await settle();
    expect(screen.getByRole('button', { name: /Drinks/ })).toBeSelected();

    // Untick it — an empty selection, which is exactly what the server still
    // reports. That one is refused.
    await fireEvent.press(screen.getByRole('button', { name: /Drinks/ }));
    await waitFor(() => expect(vote).toHaveBeenCalledWith(4, []));

    expect(await screen.findByText('This poll is closed.')).toBeTruthy();
    vote.mockRestore();
  });

  /**
   * The re-sync compares `your_votes` by *contents*, not identity. A refetch that
   * returns the same votes in a different order is not a change, and treating it
   * as one would wipe the tick you're mid-way through casting — the failure mode
   * an identity check hides, since every refetch hands back a fresh array.
   */
  it('keeps an in-flight tick when a refetch only reorders your votes', async () => {
    // Pick-any, and you've already voted twice in it.
    const multi: Poll = {
      ...CUSTOM_POLL,
      allow_multiple: true,
      your_votes: [40, 41],
      vote_count: 2,
      options: [
        ...CUSTOM_POLL.options,
        {
          id: 42,
          label: 'Cake',
          date_value: null,
          time_value: null,
          text_value: 'Cake',
          order: 2,
          count: 0,
          voters: [],
          you_voted: false,
        },
      ],
    };
    serveEvent(makeEvent({ polls: [multi] }));
    let rejectVote: (err: Error) => void = () => {};
    const vote = jest.spyOn(api, 'votePoll').mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectVote = reject;
        })
    );
    const rsvp = jest.spyOn(api, 'rsvpEvent').mockImplementation(async () => {
      // Same two votes, listed the other way round — DRF doesn't promise an
      // order on a reverse relation.
      serveEvent(makeEvent({ polls: [movedVotes(multi, [41, 40])] }));
      return served;
    });

    await renderWith(<EventScreen />);
    const cake = await screen.findByRole('button', { name: /Cake/ });
    await act(async () => {
      fireEvent.press(cake);
    });
    await waitFor(() => expect(vote).toHaveBeenCalledWith(4, [40, 41, 42]));

    // A refetch lands mid-vote. Your votes haven't changed, so neither should
    // the tick you're waiting on.
    await fireEvent.press(screen.getByRole('button', { name: /Going/ }));
    await waitFor(() => expect(rsvp).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /Cake/ })).toBeSelected();

    // And because nothing replaced it, the rollback still recognises it as ours.
    await act(async () => {
      rejectVote(new TypeError('Network request failed'));
    });
    expect(await screen.findByText(/didn’t go through/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Cake/ })).not.toBeSelected();
    expect(screen.getByRole('button', { name: /Snacks/ })).toBeSelected();
    vote.mockRestore();
    rsvp.mockRestore();
  });
});

// --- RSVP guests/note (#229) -----------------------------------------------

/**
 * `guests` and `note` are typed into `RsvpBar`, but the server owns the answer:
 * `your_response` changes under a mounted screen on every refetch — a poll vote,
 * a pull-to-refresh, or just coming back to the foreground. Seeded once, the two
 * inputs kept a stale answer beside a fresh "+ N guests" summary, and Update
 * posted the stale number back, silently reverting an RSVP made on the web. The
 * second half is the same optimism debt as the poll ticks: a rejected PATCH said
 * nothing at all.
 */
describe('RSVP guests and note', () => {
  const GOING = { response: 'going' as const, guests: 2, note: '' };

  function rsvpEvent(mine: { response: 'going'; guests: number; note: string }) {
    return makeEvent({
      polls: [CUSTOM_POLL],
      rsvp: {
        counts: { going: 1, maybe: 0, declined: 0, guests: mine.guests },
        your_response: mine,
        going_list: [],
        maybe_list: [],
        declined_list: [],
      },
    });
  }

  let served: Event;
  function serve(event: Event) {
    served = event;
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/auth/user/')) return jsonResponse(ME);
      if (url.includes('/api/events/9/')) return jsonResponse(served);
      return jsonResponse(null, 404);
    });
  }

  const guestsField = () => screen.getByLabelText("Number of guests you're bringing");
  const noteField = () => screen.getByLabelText('A note on your RSVP');

  it('re-derives your guests and note when your RSVP changes underneath', async () => {
    serve(rsvpEvent(GOING));
    // Your own RSVP round-trips, and the refetch carries the answer you changed
    // on the web a moment ago.
    const rsvp = jest.spyOn(api, 'rsvpEvent').mockImplementation(async () => {
      serve(rsvpEvent({ response: 'going', guests: 4, note: 'bringing wine' }));
      return served;
    });

    await renderWith(<EventScreen />);
    await screen.findByText('Summer camping weekend');
    expect(guestsField().props.value).toBe('2');

    await fireEvent.press(screen.getByRole('button', { name: /Going/ }));
    await waitFor(() => expect(guestsField().props.value).toBe('4'));
    expect(noteField().props.value).toBe('bringing wine');

    // ...and Update sends the newer answer, not the 2 it was seeded with.
    await fireEvent.press(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() =>
      expect(rsvp).toHaveBeenLastCalledWith(9, {
        response: 'going',
        guests: 4,
        note: 'bringing wine',
      })
    );
    rsvp.mockRestore();
  });

  it('says an RSVP that failed didn’t save, and keeps what you typed', async () => {
    serve(rsvpEvent(GOING));
    const rsvp = jest
      .spyOn(api, 'rsvpEvent')
      .mockRejectedValue(new ApiError('Couldn’t reach the server.', 500, null));

    await renderWith(<EventScreen />);
    await screen.findByText('Summer camping weekend');

    await fireEvent.changeText(noteField(), 'bringing wine');
    await fireEvent.press(screen.getByRole('button', { name: 'Update' }));

    expect(await screen.findByText('Couldn’t reach the server.')).toBeTruthy();
    // Your text stays put, so pressing Update again retries it as typed.
    expect(noteField().props.value).toBe('bringing wine');
    rsvp.mockRestore();
  });

  it('falls back to our own words when the failure isn’t the server’s', async () => {
    serve(rsvpEvent(GOING));
    // Offline, React Native rejects with this — the very case the message
    // exists for, and not a sentence to show a person.
    const rsvp = jest
      .spyOn(api, 'rsvpEvent')
      .mockRejectedValue(new TypeError('Network request failed'));

    await renderWith(<EventScreen />);
    await screen.findByText('Summer camping weekend');
    await fireEvent.press(screen.getByRole('button', { name: 'Update' }));

    expect(await screen.findByText(/didn’t save/)).toBeTruthy();
    expect(screen.queryByText(/Network request failed/)).toBeNull();
    rsvp.mockRestore();
  });

  /**
   * The clear is deliberately narrower than "the server said something": only
   * the server *arriving at your attempt* retires the message. A refetch
   * carrying some third answer is not confirmation, and swallowing the failure
   * there would put us back where #229 started — silently.
   */
  it('keeps the failure showing when the server moves to a different answer', async () => {
    serve(rsvpEvent(GOING));
    const rsvp = jest
      .spyOn(api, 'rsvpEvent')
      .mockRejectedValue(new ApiError('Couldn’t reach the server.', 500, null));
    const vote = jest.spyOn(api, 'votePoll').mockImplementation(async () => {
      // Neither what we sent nor what the server held when we sent it.
      serve(rsvpEvent({ response: 'going', guests: 5, note: 'from the web' }));
      return CUSTOM_POLL;
    });

    await renderWith(<EventScreen />);
    await screen.findByText('Summer camping weekend');
    await fireEvent.changeText(noteField(), 'bringing wine');
    await fireEvent.press(screen.getByRole('button', { name: 'Update' }));
    expect(await screen.findByText('Couldn’t reach the server.')).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: /Drinks/ }));

    // The fields have moved on to the newer truth, but your attempt still
    // didn't land — so it still says so.
    await waitFor(() => expect(guestsField().props.value).toBe('5'));
    expect(screen.getByText('Couldn’t reach the server.')).toBeTruthy();
    vote.mockRestore();
    rsvp.mockRestore();
  });

  /**
   * Re-pressing a response you already hold sends exactly what the server
   * already has, so "the server is confirming the attempt" can't be judged on
   * the answer alone — without also remembering what the server said *before*
   * the attempt, this failure would be cleared the instant it was set.
   */
  it('still says so when the rejected RSVP changed nothing', async () => {
    serve(rsvpEvent(GOING));
    const rsvp = jest
      .spyOn(api, 'rsvpEvent')
      .mockRejectedValue(new ApiError('Couldn’t reach the server.', 500, null));

    await renderWith(<EventScreen />);
    await screen.findByText('Summer camping weekend');
    await fireEvent.press(screen.getByRole('button', { name: /Going/ }));

    expect(await screen.findByText('Couldn’t reach the server.')).toBeTruthy();
    rsvp.mockRestore();
  });

  /**
   * The request had landed after all — only its response was lost. Once the
   * server states that very answer, "didn't save" would be sitting under one
   * that did.
   */
  it('stops saying so once the server confirms the answer that failed', async () => {
    serve(rsvpEvent(GOING));
    const rsvp = jest
      .spyOn(api, 'rsvpEvent')
      .mockRejectedValue(new ApiError('Couldn’t reach the server.', 500, null));
    const vote = jest.spyOn(api, 'votePoll').mockImplementation(async () => {
      serve(rsvpEvent({ response: 'going', guests: 2, note: 'bringing wine' }));
      return CUSTOM_POLL;
    });

    await renderWith(<EventScreen />);
    await screen.findByText('Summer camping weekend');
    await fireEvent.changeText(noteField(), 'bringing wine');
    await fireEvent.press(screen.getByRole('button', { name: 'Update' }));
    expect(await screen.findByText('Couldn’t reach the server.')).toBeTruthy();

    // Anything that refetches the event carries the server's answer with it.
    await fireEvent.press(screen.getByRole('button', { name: /Drinks/ }));

    await waitFor(() => expect(screen.queryByText('Couldn’t reach the server.')).toBeNull());
    vote.mockRestore();
    rsvp.mockRestore();
  });
});

// --- The personal Calendar tab ---------------------------------------------

/**
 * The event screen's own way out is held while a write that reports itself
 * *inside a child* is in flight (#256).
 *
 * Both of these are handed down as `mutateAsync` precisely so the rejection
 * reaches the component that drew the optimistic state, and neither has an
 * `onError: Alert.alert` to fall back on — so leaving first destroys the only
 * copy of the message.
 */
describe('holding the event screen while a child’s write is out', () => {
  function serveEvent(event: Event) {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/auth/user/')) return jsonResponse(ME);
      if (url.includes('/api/events/9/')) return jsonResponse(event);
      return jsonResponse(null, 404);
    });
  }

  /** A promise that only settles when the returned `refuse` is called. */
  function stall<T>(spy: jest.SpyInstance) {
    let refuse: (error: Error) => void = () => {};
    spy.mockReturnValue(
      new Promise<T>((_resolve, reject) => {
        refuse = reject;
      })
    );
    return async (error: Error) => {
      await act(async () => {
        refuse(error);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
  }

  it('refuses Back while an RSVP is saving, then says it was refused', async () => {
    // You tap Going, set your guests and type a note, then leave. The 403 for a
    // group you were removed from lands in a screen that's gone: you believe
    // you're down for three, and nobody is expecting you.
    serveEvent(makeEvent({}));
    const rsvp = jest.spyOn(api, 'rsvpEvent');
    const refuse = stall<Event>(rsvp);

    await renderWith(<EventScreen />);
    await screen.findByText('Summer camping weekend');
    await fireEvent.press(screen.getByRole('button', { name: /Going/ }));
    // The write is genuinely out: React Query dispatches `isPending` through
    // its notify manager, so it lands a macrotask after the press — check too
    // early and nothing below is being tested.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Going/ })).toBeDisabled()
    );

    await fireEvent.press(screen.getByLabelText('Back'));
    expect(router.back).not.toHaveBeenCalled();

    await refuse(new ApiError('You’re no longer in this group.', 403, null));
    expect(
      await screen.findByText('You’re no longer in this group.')
    ).toBeTruthy();
    rsvp.mockRestore();
  });

  it('refuses Back while a comment on the event is saving', async () => {
    // The fourth write on this screen, and the one that doesn't belong to it:
    // `CommentThread`'s reply box is the only renderer of its own refusal, and
    // its hold forwards up to the screen that owns Back and the swipe.
    serveEvent(makeEvent({}));

    await renderWith(<EventScreen />);
    await screen.findByText('Summer camping weekend');
    await fireEvent.changeText(
      await screen.findByLabelText('Write a comment…'),
      'see you there'
    );

    const server = holdRequest(mockFetch, { detail: 'This event is closed.' }, 403);
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Post comment'));
    });
    await server.inFlight('Posting…');

    await fireEvent.press(screen.getByLabelText('Back'));
    expect(router.back).not.toHaveBeenCalled();

    await server.refuse();
    expect(await screen.findByText('This event is closed.')).toBeTruthy();
  });

  it('refuses Back while a vote is out, then says it was refused', async () => {
    // The tick is optimistic, so leaving takes both the rollback and the
    // message: the tally you come back to reads as "nobody has voted".
    serveEvent(makeEvent({ polls: [CUSTOM_POLL] }));
    const vote = jest.spyOn(api, 'votePoll');
    const refuse = stall<unknown>(vote);

    await renderWith(<EventScreen />);
    const drinks = await screen.findByRole('button', { name: /Drinks/ });
    // Braced, not awaited: `toggle` is `async`, so awaiting the press would
    // wait on the very request this test is holding open.
    await act(async () => {
      fireEvent.press(drinks);
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Drinks/ })).toBeDisabled()
    );

    await fireEvent.press(screen.getByLabelText('Back'));
    expect(router.back).not.toHaveBeenCalled();

    await refuse(new ApiError('This poll is closed.', 409, null));
    expect(await screen.findByText('This poll is closed.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Drinks/ })).not.toBeSelected();
    vote.mockRestore();
  });
});

describe('calendar tab', () => {
  it('lists the events across your groups', async () => {
    const scheduled = makeEvent({
      id: 12,
      title: 'Book club',
      status: 'scheduled',
      event_date: '2026-08-01',
      starts_at: '2026-08-01T18:00:00Z',
      start_time: '18:00:00',
    });
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/auth/user/')) return jsonResponse(ME);
      if (url.includes('/api/calendar/')) return jsonResponse([scheduled]);
      return jsonResponse(null, 404);
    });

    await renderWith(<CalendarScreen />);

    expect(await screen.findByText('Book club')).toBeTruthy();
  });

  it('shows an empty state when nothing is scheduled', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/auth/user/')) return jsonResponse(ME);
      if (url.includes('/api/calendar/')) return jsonResponse([]);
      return jsonResponse(null, 404);
    });

    await renderWith(<CalendarScreen />);

    expect(await screen.findByText(/Nothing on the calendar/)).toBeTruthy();
  });

  /**
   * A failed load is not an empty calendar (#312).
   *
   * The screen read no error flag at all: `data` came back undefined, `events`
   * fell to `[]`, and someone with a group dinner tomorrow was told they were
   * free — with no hint the app couldn't ask, and no way to make it try again.
   */
  describe('when the load fails', () => {
    function failCalendar(status = 503, detail = 'Service unavailable.') {
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes('/api/auth/user/')) return jsonResponse(ME);
        if (url.includes('/api/calendar/')) return jsonResponse({ detail }, status);
        return jsonResponse(null, 404);
      });
    }

    it('says so rather than that nothing is scheduled', async () => {
      failCalendar();

      await renderWith(<CalendarScreen />);

      expect(await screen.findByText(/Couldn’t load your calendar/)).toBeTruthy();
      // The server's own sentence, not a synthesized one.
      expect(screen.getByText('Service unavailable.')).toBeTruthy();
      expect(screen.queryByText(/Nothing on the calendar/)).toBeNull();
    });

    it('loads the calendar when Try again works', async () => {
      failCalendar();
      await renderWith(<CalendarScreen />);
      await screen.findByText(/Couldn’t load your calendar/);

      const scheduled = makeEvent({ id: 12, title: 'Book club', status: 'scheduled' });
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes('/api/auth/user/')) return jsonResponse(ME);
        if (url.includes('/api/calendar/')) return jsonResponse([scheduled]);
        return jsonResponse(null, 404);
      });

      await fireEvent.press(screen.getByText('Try again'));

      expect(await screen.findByText('Book club')).toBeTruthy();
    });

    it('keeps the events it has when a refresh fails', async () => {
      // `isError && !data`, not a bare `isError` — the same way round as every
      // other screen. A failed refetch keeps what loaded rather than replacing
      // a full calendar with an apology.
      const scheduled = makeEvent({ id: 12, title: 'Book club', status: 'scheduled' });
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes('/api/auth/user/')) return jsonResponse(ME);
        if (url.includes('/api/calendar/')) return jsonResponse([scheduled]);
        return jsonResponse(null, 404);
      });
      const { client } = await renderWith(<CalendarScreen />);
      await screen.findByText('Book club');

      failCalendar();
      await act(async () => {
        await client.invalidateQueries({ queryKey: ['personalCalendar'] });
      });
      // The cache flips to 'error' a render before the screen does — React
      // Query notifies on a macrotask — so without this flush the assertions
      // below read the pre-error tree and pass with the bug still in place.
      await settle(2);

      expect(screen.getByText('Book club')).toBeTruthy();
      expect(screen.queryByText(/Couldn’t load your calendar/)).toBeNull();
    });
  });
});

// --- The group page's event surfaces ---------------------------------------

describe('group page events', () => {
  function serveGroup({
    upcoming = [],
    past = [],
    calendar = [],
  }: { upcoming?: Event[]; past?: Event[]; calendar?: Event[] } = {}) {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/auth/user/')) return jsonResponse(ME);
      if (url.includes('/api/groups/7/posts/')) {
        return jsonResponse({ count: 0, next: null, previous: null, results: [] });
      }
      if (url.includes('/api/groups/7/events/?window=upcoming')) return jsonResponse(upcoming);
      if (url.includes('/api/groups/7/events/?window=past')) return jsonResponse(past);
      if (url.includes('/api/groups/7/calendar/')) return jsonResponse(calendar);
      if (url.includes('/api/groups/7/')) return jsonResponse(GROUP);
      return jsonResponse(null, 404);
    });
  }

  it('shows an upcoming scheduled event above the composer', async () => {
    const upcoming = makeEvent({
      id: 20,
      title: 'Hill walk',
      status: 'scheduled',
      event_date: '2026-08-10',
      starts_at: '2026-08-10T09:00:00Z',
      start_time: '09:00:00',
    });
    serveGroup({ upcoming: [upcoming] });

    await renderWith(<GroupScreen />);

    expect(await screen.findByText('Hill walk')).toBeTruthy();
    expect(screen.getByText('↑ 1 upcoming')).toBeTruthy();
  });

  it('weaves a past event into the timeline as a recap', async () => {
    const past = makeEvent({
      id: 21,
      title: 'Spring picnic',
      status: 'scheduled',
      is_past: true,
      event_date: '2026-04-05',
      starts_at: '2026-04-05T12:00:00Z',
      start_time: '12:00:00',
      rsvp: {
        counts: { going: 6, maybe: 0, declined: 0, guests: 0 },
        your_response: null,
        going_list: [],
        maybe_list: [],
        declined_list: [],
      },
    });
    serveGroup({ past: [past] });

    await renderWith(<GroupScreen />);

    expect(await screen.findByText('Spring picnic')).toBeTruthy();
    // The recap carries its turnout.
    expect(screen.getByText('6 went')).toBeTruthy();
  });

  it('swaps the timeline for the month grid when you toggle to Calendar', async () => {
    const dated = makeEvent({
      id: 22,
      title: 'Quiz night',
      status: 'scheduled',
      event_date: '2026-08-14',
      starts_at: '2026-08-14T19:00:00Z',
      start_time: '19:00:00',
    });
    // The group calendar query is lazy (fires only in the calendar view), so the
    // event appears in the grid only after the toggle.
    serveGroup({ calendar: [dated] });

    await renderWith(<GroupScreen />);
    await screen.findByText('Family group'); // group loaded (its description)

    expect(screen.queryByText('Quiz night')).toBeNull();
    // Await the press: the later assertion reads the state it sets (the view
    // toggle), which won't flush otherwise.
    await fireEvent.press(screen.getByRole('button', { name: 'Calendar' }));

    expect(await screen.findByText(/Quiz night/)).toBeTruthy();
  });
});

// --- Comments and reactions on the event ------------------------------------
//
// An event is authored content, so it carries the same pair a post does. The
// visibility rules are the server's (and tested there); what matters here is
// that the thread and the chips are wired to the *event*.
//
// Note the URL matching below puts `/comments/` **before** the bare
// `/api/events/9/`, which would otherwise swallow it — `includes` is a prefix
// test, and serving the event payload to the comments query is a silent
// no-comments state rather than an error.

describe('event comments and reactions', () => {
  function serveEvent(event: Event, comments: unknown[] = []) {
    mockFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url.includes('/api/auth/user/')) return jsonResponse(ME);
      if (url.includes('/api/events/9/comments/')) {
        return jsonResponse(opts?.method === 'POST' ? { id: 1 } : comments);
      }
      if (url.includes('/api/events/9/react/')) {
        return jsonResponse({
          reactions: [{ emoji: '🎉', count: 1, reacted: true }],
        });
      }
      if (url.includes('/api/events/9/')) return jsonResponse(event);
      return jsonResponse(null, 404);
    });
  }

  it('loads the thread from the event, not from a post of the same id', async () => {
    serveEvent(makeEvent(), [
      {
        id: 3,
        author: { id: 2, display_name: 'Ada Lovelace', avatar_thumb: null },
        parent: null,
        text: 'are we still on?',
        created_at: '2026-08-01T10:00:00Z',
        edited_at: null,
        deleted_at: null,
        replies: [],
        reactions: [],
      },
    ]);

    await renderWith(<EventScreen />);
    await screen.findByText('Summer camping weekend');

    expect(await screen.findByText('are we still on?')).toBeTruthy();
    // Event 9 and post 9 both exist, so a thread routed on the bare number
    // would fetch the wrong one.
    const urls = mockFetch.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.includes('/api/events/9/comments/'))).toBe(true);
    expect(urls.some((u) => u.includes('/api/posts/9/comments/'))).toBe(false);
  });

  it('posts a comment onto the event', async () => {
    serveEvent(makeEvent());
    await renderWith(<EventScreen />);
    await screen.findByText('Summer camping weekend');

    // `findBy`, not `getBy`: the event query and the comments query resolve
    // independently, so the composer isn't guaranteed to be mounted just
    // because the title is. As a `getBy` this failed only under load (a second
    // suite in the same worker) — it passed alone and failed in CI.
    await fireEvent.changeText(
      await screen.findByPlaceholderText('Write a comment…'),
      'bringing a cake'
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Post comment' }));

    await waitFor(() => {
      const post = mockFetch.mock.calls.find(
        (c) =>
          (c[0] as string).includes('/api/events/9/comments/') &&
          (c[1] as RequestInit | undefined)?.method === 'POST'
      );
      expect(post).toBeTruthy();
      expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({
        text: 'bringing a cake',
        parent: null,
      });
    });
  });

  it('renders the reaction chips the server sent', async () => {
    serveEvent(
      makeEvent({ reactions: [{ emoji: '🎉', count: 3, reacted: false }] })
    );
    await renderWith(<EventScreen />);
    await screen.findByText('Summer camping weekend');

    expect(await screen.findByText('3')).toBeTruthy();
  });

  it('shows the comment count beside the chips', async () => {
    serveEvent(makeEvent({ comment_count: 4 }));
    await renderWith(<EventScreen />);

    expect(await screen.findByText('4 comments')).toBeTruthy();
  });
});

// --- EventTimelineEntry: where the voice of time lives ----------------------
//
// The entry threads the same spine a `PostCard` does, and `PostCard` puts the
// clock time **inline** at the head of the entry rather than in a rail, so the
// spine can hug the screen edge (see `timeline.tsx`). The first port of this
// component kept the web's rail — a stacked mono time inside the 36pt
// `SPINE_COLUMN`, which has the 2pt spine drawn down the middle of it — so the
// time was painted across the line and wrapped inside a box narrower than it
// needed. These pin the inline shape: one text node per value, no stacking.

describe('EventTimelineEntry', () => {
  const past = makeEvent({
    id: 40,
    title: 'Spring picnic',
    status: 'scheduled',
    is_past: true,
    event_date: '2026-04-05',
    starts_at: '2026-04-05T12:30:00Z',
    start_time: '12:30:00',
    location_name: 'Riverside Park',
    dimensions: {
      date: { state: 'set', poll: null },
      time: { state: 'set', poll: null },
      location: { state: 'set', poll: null },
    },
  });

  it('leads a past recap with the clock time inline, beside the organiser', async () => {
    await renderWith(<EventTimelineEntry event={past} variant="past" />);

    // Two nodes carry the time: the band at the head of the entry, and the Time
    // chip below (the chips stay on a past recap, as on the web). **The
    // spelling is the assertion** — the rail put a literal newline between
    // "12:30" and "pm" to fit the 36pt column, which normalises to "12:30 pm"
    // and matches neither query below.
    expect(screen.getAllByText('12:30pm')).toHaveLength(2);
    expect(screen.queryByText('12:30 pm')).toBeNull();
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    expect(screen.getByText('Spring picnic')).toBeTruthy();
  });

  it('says "all day" in the band when a past event has no time', async () => {
    await renderWith(
      <EventTimelineEntry
        event={{
          ...past,
          start_time: null,
          starts_at: null,
          dimensions: { ...past.dimensions, time: { state: 'unset', poll: null } },
        }}
        variant="past"
      />
    );

    expect(screen.getByText('all day')).toBeTruthy();
  });

  it('carries the reaction row and comment count, as a post on this spine does', async () => {
    await renderWith(
      <EventTimelineEntry
        event={{ ...past, reactions: [{ emoji: '🎉', count: 2, reacted: false }], comment_count: 3 }}
        variant="past"
      />
    );

    expect(screen.getByText('2')).toBeTruthy();
    // The count links through to the event screen rather than unfolding the
    // thread in place — an event's conversation lives beside its polls and RSVP.
    expect(screen.getByText('3 comments')).toBeTruthy();
  });

  it('invites a first comment when there are none', async () => {
    await renderWith(<EventTimelineEntry event={past} variant="past" />);
    expect(screen.getByText('Comment')).toBeTruthy();
  });

  it('leads a future entry with the whole date, since no divider carries it', async () => {
    const future = { ...past, is_past: false, start_time: '19:00:00' };
    await renderWith(<EventTimelineEntry event={future} variant="future" />);

    // **Derived, not spelled.** `formatEventDate` goes through
    // `toLocaleDateString`, so the expected text is "Sun 5 Apr" on a British
    // runner and "Sun, Apr 5" on CI's — hardcoding either makes the suite pass
    // in one place and fail in the other, which is what it did. The claim here
    // is the *composition* (one node, date · time); how a date is spelled is
    // `eventFormat.test.ts`'s job. Same trap as the runner's timezone.
    const when = `${formatEventDate('2026-04-05')} · ${formatEventTime('19:00:00')}`;
    expect(screen.getByText(when)).toBeTruthy();
  });
});

// --- The photo album -------------------------------------------------------
//
// Who may see which photo is enforced (and tested exhaustively) on the backend.
// What the client owns is that **no surface claims more photos than it can
// show**. A card holds four previews and sends you to the event for the rest;
// the event screen holds the whole album, a page at a time. The bug this
// replaced had both of them counting an album they'd only been handed the first
// slice of — a "+N" opening a viewer that stopped at the fourth photo, and a
// heading saying 47 over twenty tiles with no way to reach the other 27.

function makePhoto(id: number, uploaderName = 'Ada Lovelace', canDelete = false) {
  return {
    id,
    image: `https://x/full-${id}.jpg`,
    thumbnail: `https://x/thumb-${id}.jpg`,
    width: 120,
    height: 90,
    uploader: { id: 2, display_name: uploaderName, avatar_thumb: null },
    created_at: '2026-06-01T10:00:00Z',
    can_delete: canDelete,
  };
}

describe('event photos', () => {
  it('shows the album previews on a timeline entry', async () => {
    const event = makeEvent({
      id: 41,
      status: 'scheduled',
      is_past: true,
      event_date: '2026-04-05',
      starts_at: '2026-04-05T12:30:00Z',
      photos: [makePhoto(1), makePhoto(2)],
      photo_count: 2,
    });
    await renderWith(<EventTimelineEntry event={event} variant="past" />);

    expect(screen.getByLabelText('View event photo 1 of 2')).toBeTruthy();
    expect(screen.getByLabelText('View event photo 2 of 2')).toBeTruthy();
  });

  it('caps the tiles at four and sends the "+N" to the event, not to a viewer', async () => {
    // The two numbers earning their keep: the payload carries four photos, the
    // album holds eleven, and the card has to say so rather than imply the
    // album is what it was sent.
    const event = makeEvent({
      id: 42,
      status: 'scheduled',
      is_past: true,
      event_date: '2026-04-05',
      starts_at: '2026-04-05T12:30:00Z',
      photos: [1, 2, 3, 4].map((n) => makePhoto(n)),
      photo_count: 11,
    });
    await renderWith(<EventTimelineEntry event={event} variant="past" />);

    expect(screen.getByText('+7')).toBeTruthy();
    // The label says what the control *does*. It used to promise all eleven and
    // open a viewer holding four.
    const overflow = screen.getByLabelText('See all 11 photos on the event');
    expect(screen.queryByLabelText('View all 11 photos')).toBeNull();

    await fireEvent.press(overflow);
    expect(router.push).toHaveBeenCalledWith('/events/42');
  });

  it('labels the preview tiles against the viewer they open, not the album', async () => {
    // 🔒 The regression: with the tiles labelled "1 of 11" and the viewer
    // holding four, the counter read "1 / 4" over a label promising eleven.
    const event = makeEvent({
      id: 43,
      status: 'scheduled',
      is_past: true,
      event_date: '2026-04-05',
      starts_at: '2026-04-05T12:30:00Z',
      photos: [1, 2, 3, 4].map((n) => makePhoto(n)),
      photo_count: 11,
    });
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/auth/user/')) return jsonResponse(ME);
      return jsonResponse(null, 404);
    });

    await renderWith(<EventTimelineEntry event={event} variant="past" />);
    expect(screen.queryByLabelText('View event photo 1 of 11')).toBeNull();

    await act(async () => {
      fireEvent.press(screen.getByLabelText('View event photo 1 of 4'));
    });

    // The counter agrees with the label, and the card fetched no album to fill
    // a viewer it can't page — a group timeline of ten events must not fire ten
    // album requests, and one un-paged page couldn't hold the album anyway.
    await waitFor(() => expect(screen.getByText('1 / 4')).toBeTruthy());
    expect(
      mockFetch.mock.calls.some((c) => String(c[0]).includes('/photos/'))
    ).toBe(false);
  });

  it('lists the album on the event screen and names who added each photo', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/auth/user/')) return jsonResponse(ME);
      if (url.includes('/api/events/9/photos/'))
        return jsonResponse({ results: [makePhoto(1, 'Ali Khan')], next: null, count: 1 });
      if (url.includes('/api/events/9/')) return jsonResponse(makeEvent());
      return jsonResponse(null, 404);
    });

    await renderWith(<EventScreen />);
    await screen.findByText('Photos');

    await act(async () => {
      fireEvent.press(await screen.findByLabelText('View photo 1 of 1'));
    });
    await waitFor(() => expect(screen.getByText('Ali Khan')).toBeTruthy());
  });

  it("says the album is *this viewer's* slice, never that it's empty", async () => {
    // Deliberate wording: what you see is pruned to the uploaders you may see,
    // so "there are no photos" would be a claim the client can't make.
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/auth/user/')) return jsonResponse(ME);
      if (url.includes('/api/events/9/photos/'))
        return jsonResponse({ results: [], next: null, count: 0 });
      if (url.includes('/api/events/9/')) return jsonResponse(makeEvent());
      return jsonResponse(null, 404);
    });

    await renderWith(<EventScreen />);
    expect(await screen.findByText('No photos here yet — add the first.')).toBeTruthy();
  });

  it('only offers Remove on a photo the payload says you can remove', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/auth/user/')) return jsonResponse(ME);
      if (url.includes('/api/events/9/photos/'))
        return jsonResponse({
          results: [makePhoto(1, 'Ali Khan', false)],
          next: null,
          count: 1,
        });
      if (url.includes('/api/events/9/')) return jsonResponse(makeEvent());
      return jsonResponse(null, 404);
    });

    await renderWith(<EventScreen />);
    await act(async () => {
      fireEvent.press(await screen.findByLabelText('View photo 1 of 1'));
    });
    await waitFor(() => expect(screen.getByLabelText('Close photo viewer')).toBeTruthy());
    expect(screen.queryByLabelText('Remove this photo')).toBeNull();
  });

  it('offers Remove on your own photo, confirms, and then removes it', async () => {
    // The album empties once the DELETE lands, which is what the server does:
    // the page is refetched after the write.
    let removed = false;
    mockFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url.includes('/api/auth/user/')) return jsonResponse(ME);
      if (url.includes('/api/event-photos/1/') && init?.method === 'DELETE') {
        removed = true;
        return jsonResponse(null, 204);
      }
      if (url.includes('/api/events/9/photos/'))
        return jsonResponse({
          results: removed ? [] : [makePhoto(1, 'Me Myself', true)],
          next: null,
          count: removed ? 0 : 1,
        });
      if (url.includes('/api/events/9/')) return jsonResponse(makeEvent());
      return jsonResponse(null, 404);
    });

    await renderWith(<EventScreen />);
    await act(async () => {
      fireEvent.press(await screen.findByLabelText('View photo 1 of 1'));
    });
    await act(async () => {
      fireEvent.press(await screen.findByLabelText('Remove this photo'));
    });

    // A photo comes off for everyone, so it stops at a confirm first — the same
    // rule a post's delete follows, worded for what this one takes.
    expect(alertSpy).toHaveBeenCalledWith(
      'Remove this photo?',
      expect.stringContaining('everyone who can see it'),
      expect.any(Array)
    );
    expect(
      mockFetch.mock.calls.some((c) => String(c[0]).includes('/api/event-photos/1/'))
    ).toBe(false);

    // And then the other half, which nothing used to press: the confirm has to
    // actually reach the server. A Remove that stops at the dialog is a
    // delete that never happens.
    await act(async () => {
      pressAlertButton('Remove this photo?', 'Remove');
    });
    await waitFor(() =>
      expect(
        mockFetch.mock.calls.some(
          ([url, init]) =>
            String(url).includes('/api/event-photos/1/') && init?.method === 'DELETE'
        )
      ).toBe(true)
    );
    // The viewer closes on success — it was showing a photo that's gone.
    await waitFor(() =>
      expect(screen.queryByLabelText('Close photo viewer')).toBeNull()
    );
  });

  it('uploads the photos you pick, capped at what one request may carry', async () => {
    // 🔒 The cap is the point. `selectionLimit` left off means *the system
    // maximum* to expo-image-picker — and every asset picked is read into
    // memory at once before the request leaves, so an uncapped pick is an OOM
    // on an older phone as well as a request the server will refuse.
    pickFromLibrary.mockResolvedValue({
      canceled: false,
      // Twelve, so the request is trimmed even if the picker ignores the limit
      // it was given — which is the half that protects the phone's memory.
      assets: Array.from({ length: 12 }, (_, i) => ({
        uri: `file:///tmp/${i}.jpg`,
        fileName: `${i}.jpg`,
        mimeType: 'image/jpeg',
      })),
    });
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/auth/user/')) return jsonResponse(ME);
      if (url.includes('/api/events/9/photos/'))
        return jsonResponse({ results: [], next: null, count: 0 });
      if (url.includes('/api/events/9/')) return jsonResponse(makeEvent());
      return jsonResponse(null, 404);
    });

    await renderWith(<EventScreen />);
    await screen.findByText('Photos');

    // Not awaited: `pickPhotos` doesn't resolve until the source is chosen.
    fireEvent.press(screen.getByLabelText('Add photos to this event'));
    await choosePhotoSource('Choose from Library');

    expect(pickFromLibrary).toHaveBeenCalledWith(
      expect.objectContaining({ allowsMultipleSelection: true, selectionLimit: 10 })
    );
    await waitFor(() =>
      expect(
        mockFetch.mock.calls.some(
          ([url, init]) =>
            String(url).includes('/api/events/9/photos/') && init?.method === 'POST'
        )
      ).toBe(true)
    );
    const post = mockFetch.mock.calls.find(
      ([url, init]) =>
        String(url).includes('/api/events/9/photos/') && init?.method === 'POST'
    );
    // Ten, the server's `MAX_PHOTOS_PER_UPLOAD` — and ten is also how many
    // full-resolution images `api.ts` holds in memory at once building this
    // body, which is the limit that matters on an older phone.
    expect((post![1].body as FormData).getAll('photos')).toHaveLength(10);
  });
});

// --- Paging the album ------------------------------------------------------
//
// One page is 20 and an album holds up to 200, so the album screen is the one
// surface that has to page. It lives inside the event screen's scroll view, so
// there's no `onEndReached` to hang this off: the last tile takes the "+N" and
// loading the next page is a tap on it.

/** A page of the album, `n` photos numbered from `from`. */
function albumPage(from: number, n: number, count: number, next: string | null) {
  return {
    results: Array.from({ length: n }, (_, i) => makePhoto(from + i)),
    next,
    previous: null,
    count,
  };
}

describe('the album on the event screen', () => {
  /** Page 1 of 20 with 5 behind it, and a page 2 that finishes the album. */
  function pagedAlbum() {
    mockFetch.mockImplementation(async (url: string) => {
      const at = String(url);
      if (at.includes('/api/auth/user/')) return jsonResponse(ME);
      if (at.includes('/api/events/9/photos/'))
        return at.includes('page=2')
          ? jsonResponse(albumPage(21, 5, 25, null))
          : jsonResponse(
              albumPage(1, 20, 25, 'https://api.example.test/api/events/9/photos/?page=2')
            );
      if (at.includes('/api/events/9/')) return jsonResponse(makeEvent());
      return jsonResponse(null, 404);
    });
  }

  it('reaches the photos past the first page', async () => {
    // 🔒 The bug: 25 in the heading, 20 tiles, and no affordance of any kind for
    // the other five.
    pagedAlbum();
    await renderWith(<EventScreen />);

    await screen.findByText('Photos');
    expect(await screen.findByText('25')).toBeTruthy();
    // The last tile is the way to the rest, and says how many that is.
    expect(await screen.findByText('+5')).toBeTruthy();
    const more = screen.getByLabelText('Load 5 more photos');

    await act(async () => {
      fireEvent.press(more);
    });

    // Every photo is now on screen and openable, and nothing is left counting.
    await waitFor(() =>
      expect(screen.getByLabelText('View photo 25 of 25')).toBeTruthy()
    );
    expect(screen.queryByText('+5')).toBeNull();
  });

  it('says it could not load them, rather than that there are none', async () => {
    // 🔒 The two lines used to render together: "No photos here yet" *and* the
    // load error. The first is a claim the client can't make about a request
    // that failed.
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/auth/user/')) return jsonResponse(ME);
      if (url.includes('/api/events/9/photos/')) return jsonResponse(null, 500);
      if (url.includes('/api/events/9/')) return jsonResponse(makeEvent());
      return jsonResponse(null, 404);
    });

    await renderWith(<EventScreen />);

    expect(await screen.findByText('Couldn’t load the photos.')).toBeTruthy();
    expect(screen.queryByText('No photos here yet — add the first.')).toBeNull();
  });

  it('says a *later* page failed without disowning the ones it has', async () => {
    // The other half of the same rule: photos did load, so the album isn't
    // empty and isn't unloadable — it's short, and the sentence says which.
    mockFetch.mockImplementation(async (url: string) => {
      const at = String(url);
      if (at.includes('/api/auth/user/')) return jsonResponse(ME);
      if (at.includes('/api/events/9/photos/'))
        return at.includes('page=2')
          ? jsonResponse(null, 500)
          : jsonResponse(
              albumPage(1, 20, 25, 'https://api.example.test/api/events/9/photos/?page=2')
            );
      if (at.includes('/api/events/9/')) return jsonResponse(makeEvent());
      return jsonResponse(null, 404);
    });

    await renderWith(<EventScreen />);
    await act(async () => {
      fireEvent.press(await screen.findByLabelText('Load 5 more photos'));
    });

    expect(await screen.findByText('Couldn’t load all the photos.')).toBeTruthy();
    expect(screen.queryByText('Couldn’t load the photos.')).toBeNull();
    expect(screen.getByLabelText('View photo 1 of 20')).toBeTruthy();
  });
});

// --- MonthGrid (component) -------------------------------------------------

describe('MonthGrid', () => {
  it('renders the month heading, weekday row, and an event in its day cell', async () => {
    const dated = makeEvent({
      id: 30,
      title: 'Quiz night',
      status: 'scheduled',
      event_date: '2026-08-14',
      starts_at: '2026-08-14T19:00:00Z',
      start_time: '19:00:00',
    });
    await render(<MonthGrid events={[dated]} />);

    expect(screen.getByText('August 2026')).toBeTruthy();
    expect(screen.getByText('Mon')).toBeTruthy();
    expect(screen.getByText(/Quiz night/)).toBeTruthy();
  });

  /**
   * Android back closes the day panel rather than the calendar (#168).
   *
   * A cell shows three events before it collapses the rest behind "+N more",
   * and the panel that opens is a plain view, not a Modal — so back skipped
   * straight past it and off the calendar screen.
   */
  androidIt('closes the “+N more” day panel on Android back', async () => {
    captureBackHandler();
    const busyDay = [1, 2, 3, 4].map((n) =>
      makeEvent({
        id: 30 + n,
        title: `Event ${n}`,
        status: 'scheduled',
        event_date: '2026-08-14',
        starts_at: '2026-08-14T19:00:00Z',
        start_time: '19:00:00',
      })
    );
    await render(<MonthGrid events={busyDay} />);

    await fireEvent.press(screen.getByText('+1 more'));
    // The panel lists every event for the day — all four, group name and all,
    // where the cell itself had room for three.
    expect(screen.getAllByText('The Andersons')).toHaveLength(4);

    await act(async () => {
      expect(pressBack()).toBe(true);
    });

    expect(screen.queryAllByText('The Andersons')).toHaveLength(0);
    // Still on the calendar, with the affordance to reopen it.
    expect(screen.getByText('August 2026')).toBeTruthy();
    expect(screen.getByText('+1 more')).toBeTruthy();
  });
});

// --- Unreachable is not the same as cancelled (#309) -------------------------

/**
 * The screen used to branch on `notFound || !event`, which gave the *missing*
 * answer to every kind of failure. With `retry: false` on this query, a dropped
 * packet or a 500 on the first load leaves `isLoading` false with no data — so a
 * bad connection was reported as "It may have been cancelled, or you're not
 * connected to whoever organised it", something the client has no way of
 * knowing. And once an event *is* loaded, a failed refresh of it must not take
 * it off the screen either: `staleTime` is 0 and every foreground refetches
 * `['event', id]`.
 */
describe('an event that can’t be reached', () => {
  function serveEvent(status: number, body: unknown) {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/auth/user/')) return jsonResponse(ME);
      if (url.includes('/api/events/9/')) return jsonResponse(body, status);
      return jsonResponse(null, 404);
    });
  }

  it('says the load failed, not that the event may have been cancelled', async () => {
    serveEvent(503, { detail: 'Service unavailable.' });

    await renderWith(<EventScreen />);

    expect(await screen.findByText('Couldn’t load this event')).toBeTruthy();
    expect(screen.queryByText('Event not available')).toBeNull();
  });

  it('still says the event is gone on a 404', async () => {
    // The answer this copy was written for, and the only one it should give.
    serveEvent(404, { detail: 'Not found.' });

    await renderWith(<EventScreen />);

    expect(await screen.findByText('Event not available')).toBeTruthy();
    expect(screen.queryByText('Couldn’t load this event')).toBeNull();
  });

  it('keeps a loaded event when a refresh of it fails', async () => {
    serveEvent(200, makeEvent());
    const { client } = await renderWith(<EventScreen />);
    await screen.findByText('Summer camping weekend');
    serveEvent(503, { detail: 'Service unavailable.' });

    await act(async () => {
      await client.invalidateQueries({ queryKey: ['event', 9] });
    });

    await waitFor(() =>
      expect(client.getQueryState(['event', 9])?.status).toBe('error')
    );
    // The cache flips to 'error' a render before the screen does — see the
    // profile suite's twin for why this flush is load-bearing.
    await settle(2);
    expect(screen.getByText('Summer camping weekend')).toBeTruthy();
    expect(screen.queryByText('Couldn’t load this event')).toBeNull();
  });
});
