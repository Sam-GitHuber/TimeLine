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
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { api } from '@/api';
import EventScreen from '@/app/events/[eventId]';
import CalendarScreen from '@/app/(tabs)/calendar';
import GroupScreen from '@/app/groups/[groupId]';
import { AuthProvider } from '@/auth';
import { MonthGrid } from '@/components/events/MonthGrid';
import { saveTokens } from '@/tokens';
import type { Event, Group, Poll, User } from '@/types';

const mockParams: Record<string, string> = { eventId: '9', groupId: '7' };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
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
    created_at: '2026-07-18T10:00:00Z',
    updated_at: '2026-07-18T10:00:00Z',
    polls: [DATE_POLL],
    ...overrides,
  };
}

// `await render(...)`: under React 19's concurrent root the initial commit lands
// in a microtask, so an unawaited render leaves `screen` unpopulated (the shared
// helper pattern the other suites use — see people.test / groupDetail.test).
async function renderWith(node: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{node}</AuthProvider>
    </QueryClientProvider>
  );
}

beforeEach(async () => {
  mockFetch.mockReset();
  mockParams.eventId = '9';
  mockParams.groupId = '7';
  globalThis.fetch = mockFetch as unknown as typeof fetch;
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

// --- The personal Calendar tab ---------------------------------------------

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
});
