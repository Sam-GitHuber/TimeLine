/**
 * The group page (Phase 9 E3a) — its timeline renders, and composing there posts
 * *into the group*, not the home feed.
 *
 * The load-bearing new wiring is the group-scoped compose: `ComposeBox` with a
 * `groupId` must call `createPost` with that id (the server files it under the
 * group). Everything else is the same TimelineList the feed uses.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { api } from '@/api';
import GroupScreen from '@/app/groups/[groupId]';
import { AuthProvider } from '@/auth';
import { saveTokens } from '@/tokens';
import type { Event, Group, Post, User } from '@/types';

import { settle } from './helpers';

const mockParams: { groupId: string } = { groupId: '7' };
jest.mock('expo-router', () => ({
  // The screen is always focused under test, so focus is a plain effect — see
  // `jest.setup.js`, whose global stub this local factory overrides. Needed
  // here because the calendar tab renders `MonthGrid`, which uses
  // `useAndroidBack` → `useFocusEffect` (#168).
  useFocusEffect: (callback: () => void | (() => void)) =>
    // `require`, not an import: the factory is hoisted above the imports.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('react').useEffect(callback, [callback]),
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

/**
 * A past event, which falls **into** the timeline as a recap (`toGroupRows`).
 * Only the fields the row and its card read are set — the event screens' own
 * suites cover the rest.
 */
function makePastEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: 9,
    group: { id: 7, name: 'The Andersons' },
    organiser: { id: 2, display_name: 'Ada Lovelace', avatar_thumb: null },
    title: 'Summer camping weekend',
    description: 'Brought a tent.',
    event_date: '2026-07-04',
    start_time: '18:00',
    end_time: null,
    timezone: 'Europe/London',
    location_name: '',
    location_url: '',
    location_note: '',
    status: 'scheduled',
    is_past: true,
    starts_at: '2026-07-04T17:00:00Z',
    dimensions: {
      date: { state: 'set', poll: null },
      time: { state: 'set', poll: null },
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
    created_at: '2026-07-01T10:00:00Z',
    updated_at: '2026-07-01T10:00:00Z',
    polls: [],
    ...overrides,
  };
}

function makePost(overrides: Partial<Post> & { id: number }): Post {
  return {
    author: { id: 2, display_name: 'Ada Lovelace', avatar_thumb: null },
    text: `Post ${overrides.id}`,
    images: [],
    group: { id: 7, name: 'The Andersons' },
    reactions: [],
    comment_count: 0,
    new_comment_count: 0,
    created_at: '2026-07-20T10:00:00Z',
    edited_at: null,
    ...overrides,
  };
}

function serve(posts: Post[], pastEvents: Event[] = []) {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes('/api/auth/user/')) return jsonResponse(ME);
    if (url.includes('/api/groups/7/posts/')) {
      return jsonResponse({ count: posts.length, next: null, previous: null, results: posts });
    }
    // The E3b events/calendar endpoints — empty here unless a test stages a past
    // event; their own suite covers the populated cases. These must be matched
    // before the generic group route, since their URLs contain `/api/groups/7/`
    // too.
    if (url.includes('/api/groups/7/events/')) {
      return jsonResponse(url.includes('window=past') ? pastEvents : []);
    }
    if (url.includes('/api/groups/7/calendar/')) return jsonResponse([]);
    if (url.includes('/api/groups/7/')) return jsonResponse(GROUP);
    return jsonResponse(null, 404);
  });
}

async function renderScreen() {
  await saveTokens({ access: 'a', refresh: 'r' });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });
  // The client comes back so a test can drive a refetch and read the query's
  // state afterwards; callers that don't care can keep ignoring it.
  const view = await render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <GroupScreen />
      </AuthProvider>
    </QueryClientProvider>
  );
  return { client: queryClient, ...view };
}

beforeEach(() => {
  mockFetch.mockReset();
  mockParams.groupId = '7';
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

it('renders the group and its timeline', async () => {
  serve([makePost({ id: 5, text: 'A day on the hills' })]);
  await renderScreen();

  expect(await screen.findByText('A day on the hills')).toBeTruthy();
  // The group name is in the top bar; the member count links to the roster.
  expect(screen.getAllByText('The Andersons').length).toBeGreaterThan(0);
  expect(screen.getByText('4 members ›')).toBeTruthy();
});

it('composes a post into the group, not the home feed', async () => {
  serve([]);
  const createPost = jest
    .spyOn(api, 'createPost')
    .mockResolvedValue(makePost({ id: 9, text: 'Hello group' }));

  await renderScreen();
  await screen.findByText('4 members ›');

  await fireEvent.changeText(
    await screen.findByLabelText("What's happening?"),
    'Hello group'
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Post' }));

  // The third arg is the group id — this is the whole point of a group compose.
  await waitFor(() =>
    expect(createPost).toHaveBeenCalledWith('Hello group', [], 7)
  );
  createPost.mockRestore();
});

// --- A refresh that fails (#309) --------------------------------------------

/**
 * A failed *refresh* of the group must not take the group off the screen.
 *
 * `query-core`'s error action keeps the data it has and only flips `status` to
 * 'error'. `staleTime` is 0 and `focusManager` is wired to `AppState`, so every
 * foreground refetches `['group', id]` — and a failure there used to replace the
 * timeline, the upcoming events and the calendar with "Couldn't load this
 * group", on a screen that had all three.
 */
describe('a refresh that fails', () => {
  /** The group request fails from here on; its posts keep working. */
  function breakTheGroup(status: number, reason: string) {
    const base = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(async (url: string) =>
      url.includes('/api/groups/7/') &&
      !url.includes('/posts/') &&
      !url.includes('/events/') &&
      !url.includes('/calendar/')
        ? jsonResponse({ detail: reason }, status)
        : base(url)
    );
  }

  it('keeps the group and its timeline', async () => {
    serve([makePost({ id: 5, text: 'A day on the hills' })]);
    const { client } = await renderScreen();
    await screen.findByText('A day on the hills');
    breakTheGroup(503, 'Service unavailable.');

    await act(async () => {
      await client.invalidateQueries({ queryKey: ['group', 7] });
    });

    await waitFor(() =>
      expect(client.getQueryState(['group', 7])?.status).toBe('error')
    );
    // The cache flips to 'error' a render before the screen does — React Query
    // notifies on a macrotask through `notifyManager`. Without this flush the
    // assertions below run against the pre-error tree and pass against a screen
    // with the bug still in it.
    await settle(2);
    expect(screen.queryByText('Couldn’t load this group')).toBeNull();
    expect(screen.getByText('A day on the hills')).toBeTruthy();
    expect(screen.getByText('4 members ›')).toBeTruthy();
  });

  it('still says the group is unavailable on a 404, even holding a copy', async () => {
    // A 404 here means left or made private — an answer about *now*, so it
    // outranks the cached copy.
    serve([makePost({ id: 5, text: 'A day on the hills' })]);
    const { client } = await renderScreen();
    await screen.findByText('A day on the hills');
    breakTheGroup(404, 'Not found.');

    await act(async () => {
      await client.invalidateQueries({ queryKey: ['group', 7] });
    });

    expect(
      await screen.findByText('This group isn’t available.')
    ).toBeTruthy();
    expect(screen.queryByText('A day on the hills')).toBeNull();
  });

  it('still shows the error card when the first load fails', async () => {
    // Nothing cached to fall back on — the case the card is for.
    serve([]);
    breakTheGroup(503, 'Service unavailable.');
    await renderScreen();

    expect(await screen.findByText('Couldn’t load this group')).toBeTruthy();
  });
});

// --- A sub-request that fails (#317) ----------------------------------------

/**
 * The mirror image of the block above: reading `isError` **never** rather than
 * too early.
 *
 * Four queries hang off this page and the group's own is the only one that had a
 * branch. The other three failed silently into `?? []`, and the empty states
 * they fell through to are written as flat statements of fact — so a dropped
 * packet was reported as an answer, about a group whose header had loaded
 * perfectly beside it.
 */
describe('a sub-request that fails', () => {
  /**
   * Fail every request whose URL contains `match`, leaving the rest working.
   *
   * A macrotask late on purpose: a mock that rejects instantly settles inside
   * the same React batch as the render that fired it, which is not how a real
   * request behaves.
   */
  function breakEndpoint(match: string, reason = 'Server error.') {
    const base = mockFetch.getMockImplementation()!;
    // `init` is forwarded, not dropped: `serve` answers by URL today, but this
    // screen renders a `ComposeBox`, so the moment it grows a method-aware
    // branch every request routed through here would reach it looking like a
    // GET — and would surface as some unrelated test failing on a wrong body.
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (!url.includes(match)) return base(url, init);
      await new Promise((resolve) => setTimeout(resolve, 0));
      return jsonResponse({ detail: reason }, 500);
    });
  }

  it('says the posts didn’t load rather than that the group is empty', async () => {
    // The loudest one. Said to someone whose group has two years of history
    // behind it, "No posts here yet — say something to the group" reads as a
    // brand-new group, and the natural response is to post into it again.
    serve([]);
    breakEndpoint('/api/groups/7/posts/');
    await renderScreen();

    expect(await screen.findByText('Couldn’t load these posts')).toBeTruthy();
    expect(screen.getByText('Server error.')).toBeTruthy();
    expect(
      screen.queryByText('No posts here yet — say something to the group.')
    ).toBeNull();
  });

  it('still says the posts are missing when past events fill the list', async () => {
    // The recaps land on this same spine from a different query, so a cold posts
    // failure beside events that loaded fine leaves a *non-empty* list — and the
    // state in `ListEmptyComponent` never gets its turn. A timeline of nothing
    // but old event recaps, with the posts silently absent, is the same claim
    // made by omission.
    serve([], [makePastEvent()]);
    breakEndpoint('/api/groups/7/posts/');
    await renderScreen();

    expect(await screen.findByText('Summer camping weekend')).toBeTruthy();
    expect(
      screen.getByText('Couldn’t load this group’s posts.')
    ).toBeTruthy();
    // And a way out. The card that owns the other Try again is in
    // `ListEmptyComponent`, which a list full of recaps never renders, and this
    // screen passes no `refreshControl` — so without this the line is a dead end
    // of exactly the kind #317 filed `edit.tsx` for.
    expect(
      screen.getByLabelText('Try loading the posts again')
    ).toBeTruthy();
  });

  it('keeps the timeline when a posts refresh fails', async () => {
    // `isError && !data`, never a bare `isError` (#309/#311).
    serve([makePost({ id: 5, text: 'A day on the hills' })]);
    const { client } = await renderScreen();
    await screen.findByText('A day on the hills');
    breakEndpoint('/api/groups/7/posts/');

    await act(async () => {
      await client.invalidateQueries({ queryKey: ['groupPosts', 7] });
    });
    await settle(2);

    expect(screen.getByText('A day on the hills')).toBeTruthy();
    expect(screen.queryByText('Couldn’t load these posts')).toBeNull();
  });

  it('says the calendar didn’t load rather than drawing an empty month', async () => {
    // "No dated events yet" — to a group with a wedding in it on Saturday.
    serve([]);
    breakEndpoint('/api/groups/7/calendar/');
    await renderScreen();
    await fireEvent.press(await screen.findByText('Calendar'));

    expect(await screen.findByText('Couldn’t load the calendar')).toBeTruthy();
    expect(
      screen.queryByText('No dated events yet. Scheduled events show up here.')
    ).toBeNull();
  });

  it('says so when the upcoming events don’t load', async () => {
    // The subtlest of the four: the "↑ N upcoming" cue only renders when there
    // *are* upcoming events, so a failed fetch computed 0 and hid the whole
    // region — leaving nothing on screen to distinguish "nothing is planned"
    // from "we couldn't ask".
    serve([]);
    breakEndpoint('/api/groups/7/events/?window=upcoming', 'Events are down.');
    await renderScreen();

    // The server's own sentence when it wrote one, per `serverMessage`; the
    // "Couldn't load what's coming up." fallback is what an offline phone gets.
    expect(await screen.findByText('Events are down.')).toBeTruthy();
    expect(screen.getByText('Try again')).toBeTruthy();
  });

  it('says so when the past event recaps don’t load', async () => {
    // These fall *into* the timeline among the posts, so their absence leaves a
    // timeline that still looks complete.
    serve([makePost({ id: 5, text: 'A day on the hills' })]);
    breakEndpoint('/api/groups/7/events/?window=past', 'Recaps are down.');
    await renderScreen();

    // A line under the timeline, not a state replacing it: the posts that did
    // load stay exactly where they are.
    expect(await screen.findByText('A day on the hills')).toBeTruthy();
    expect(screen.getByText('Recaps are down.')).toBeTruthy();
  });
});
