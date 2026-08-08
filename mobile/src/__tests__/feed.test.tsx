/**
 * Tests for the feed screen and its day-grouping.
 *
 * The ordering assertion is the important one: reverse-chronological is the
 * product's single non-negotiable principle, so a test pins that the screen
 * renders exactly what the server sent, in that order.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import FeedScreen from '@/app/(tabs)/index';
import { toGroupRows, toRows, trimToFirstPage, type FeedPages } from '@/feed';
import { AuthProvider } from '@/auth';
import { formatEventDate } from '@/eventFormat';
import type { Event, Post } from '@/types';

// The include-groups preference moved out of the feed header into Settings
// (E4b), so the feed just *reads* it. Mock the preference here so a test can set
// it directly; the toggle interaction itself is covered in settings.test.tsx.
let mockIncludeGroups = false;
jest.mock('@/preferences', () => ({
  usePreferences: () => ({
    includeGroupsInFeed: mockIncludeGroups,
    setIncludeGroupsInFeed: jest.fn(),
  }),
  PreferencesProvider: ({ children }: { children: ReactNode }) => children,
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

function makePost(overrides: Partial<Post> & { id: number }): Post {
  return {
    author: { id: 1, display_name: 'Alice Anderson', avatar_thumb: null },
    text: `Post ${overrides.id}`,
    images: [],
    group: null,
    reactions: [],
    comment_count: 0,
    new_comment_count: 0,
    created_at: '2026-07-18T10:00:00Z',
    edited_at: null,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<Event> & { id: number }): Event {
  return {
    group: { id: 7, name: 'The Andersons' },
    organiser: { id: 2, display_name: 'Ada Lovelace', avatar_thumb: null },
    title: `Event ${overrides.id}`,
    description: '',
    event_date: null,
    start_time: null,
    end_time: null,
    timezone: 'UTC',
    location_name: '',
    location_url: '',
    location_note: '',
    status: 'scheduled',
    is_past: true,
    starts_at: null,
    dimensions: {
      date: { state: 'set', poll: null },
      time: { state: 'unset', poll: null },
      location: { state: 'unset', poll: null },
    },
    rsvp: {
      counts: { going: 1, maybe: 0, declined: 0, guests: 0 },
      your_response: null,
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
    polls: [],
    ...overrides,
  };
}

function feedPage(results: Post[], next: string | null = null) {
  return { count: results.length, next, previous: null, results };
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

function renderFeed() {
  const queryClient = makeQueryClient();
  // A fresh QueryClient per test, or one test's cache answers the next one's
  // query and the fetch mock never fires.
  //
  // `retry: false` so an error test fails fast instead of waiting out backoff.
  // `gcTime: 0` because the default five-minute garbage-collection timer keeps
  // Node's event loop alive long after the assertions finish — the tests pass,
  // then Jest sits there refusing to exit and the CI job hangs.
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <FeedScreen />
      </AuthProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  mockFetch.mockReset();
  mockIncludeGroups = false;
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

describe('day grouping', () => {
  it('emits one divider per calendar day, before that day’s posts', () => {
    const rows = toRows([
      makePost({ id: 1, created_at: '2026-07-18T15:00:00Z' }),
      makePost({ id: 2, created_at: '2026-07-18T09:00:00Z' }),
      makePost({ id: 3, created_at: '2026-07-17T09:00:00Z' }),
    ]);

    expect(rows.map((r) => r.kind)).toEqual([
      'day',
      'post',
      'post',
      'day',
      'post',
    ]);
  });

  it('preserves the server’s order exactly', () => {
    // Reverse-chronological is enforced server-side and must never be re-sorted
    // here. Feed the rows in deliberately, and check they come out untouched.
    const rows = toRows([
      makePost({ id: 10, created_at: '2026-07-18T15:00:00Z' }),
      makePost({ id: 11, created_at: '2026-07-18T09:00:00Z' }),
      makePost({ id: 12, created_at: '2026-07-18T12:00:00Z' }),
    ]);

    const ids = rows
      .filter((r): r is Extract<typeof r, { kind: 'post' }> => r.kind === 'post')
      .map((r) => r.post.id);
    expect(ids).toEqual([10, 11, 12]);
  });

  it('returns nothing for an empty feed', () => {
    expect(toRows([])).toEqual([]);
  });

  it('drops a post the paginator sent twice, keeping the first', () => {
    // Page-number pagination: a post created while you're scrolling shifts the
    // window, so page 2 re-sends what page 1 already showed. Two rows keyed
    // `post-<id>` make React warn and let FlatList recycle the wrong row.
    const rows = toRows([
      makePost({ id: 20, created_at: '2026-07-18T15:00:00Z' }),
      makePost({ id: 19, created_at: '2026-07-18T14:00:00Z' }),
      // …page 2 begins, repeating the post that slid down into it.
      makePost({ id: 19, created_at: '2026-07-18T14:00:00Z' }),
      makePost({ id: 18, created_at: '2026-07-18T13:00:00Z' }),
    ]);

    const keys = rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter((k) => k === 'post-19')).toHaveLength(1);
    // Order is still exactly the server's, minus the repeat.
    expect(
      rows
        .filter((r): r is Extract<typeof r, { kind: 'post' }> => r.kind === 'post')
        .map((r) => r.post.id)
    ).toEqual([20, 19, 18]);
  });
});

describe('group day grouping', () => {
  function dividers(rows: ReturnType<typeof toGroupRows>) {
    return rows
      .filter((r): r is Extract<typeof r, { kind: 'day' }> => r.kind === 'day')
      .map((r) => r.label);
  }

  // A post's day is its `created_at` instant read in the viewer's zone, so a
  // fixed UTC string names a different day depending on where the suite runs.
  // Build the instant *from* local parts instead, and it's the 5th of April
  // everywhere.
  const localNoon = (day: number) =>
    new Date(2026, 3, day, 12, 0, 0).toISOString();

  it("files all-day past events under their own date, not the viewer's", () => {
    // #126: the divider used to come from the `starts_at` *instant*, read in the
    // viewer's zone — so an all-day event (midnight in the *event's* zone)
    // landed under the previous day's divider, contradicting its own recap line.
    // Two events on the same day organised in far-apart zones (this app is for
    // families spread across the world): whatever zone the suite runs in, at
    // least one is mis-filed by an instant-based key, and both belong under the
    // one 5 April divider.
    const rows = toGroupRows(
      [],
      ['2026-04-05T00:00:00+13:00', '2026-04-05T00:00:00-11:00'].map(
        (starts_at, i) =>
          makeEvent({ id: 21 + i, event_date: '2026-04-05', starts_at })
      )
    );

    expect(dividers(rows)).toEqual([formatEventDate('2026-04-05')]);
    expect(rows.map((r) => r.kind)).toEqual(['day', 'event', 'event']);
  });

  it('interleaves events with posts and emits each divider once, in order', () => {
    const rows = toGroupRows(
      [
        makePost({ id: 1, created_at: localNoon(5) }),
        makePost({ id: 2, created_at: localNoon(4) }),
      ],
      [
        makeEvent({
          id: 21,
          event_date: '2026-04-05',
          starts_at: '2026-04-05T00:00:00+13:00',
        }),
      ]
    );

    // The event belongs to the 5th, so it sits under that divider, below the
    // 5th's post (midnight is earlier than noon) and above the 4th's.
    expect(rows.map((r) => r.kind)).toEqual([
      'day',
      'post',
      'event',
      'day',
      'post',
    ]);
    expect(dividers(rows)).toEqual([
      formatEventDate('2026-04-05'),
      formatEventDate('2026-04-04'),
    ]);
  });

  it('keeps a date-less event on the line rather than dropping it to the epoch', () => {
    // Defensive: a date-less event can't be past, so it shouldn't arrive here —
    // but if it does it should sit by its creation time, not in 1970 under a
    // divider of its own.
    const rows = toGroupRows(
      [makePost({ id: 1, created_at: '2026-07-18T15:00:00Z' })],
      [makeEvent({ id: 21, created_at: '2026-07-18T09:00:00Z' })]
    );

    expect(rows.map((r) => r.kind)).toEqual(['day', 'post', 'event']);
  });
});

describe('feed screen', () => {
  it('renders the posts the API returns', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(
        feedPage([
          makePost({ id: 1, text: 'Anyone up for a walk this weekend?' }),
          makePost({ id: 2, text: 'Second post' }),
        ])
      )
    );

    await renderFeed();

    expect(
      await screen.findByText('Anyone up for a walk this weekend?')
    ).toBeTruthy();
    expect(screen.getByText('Second post')).toBeTruthy();
  });

  it('shows the empty state when there are no posts', async () => {
    mockFetch.mockResolvedValue(jsonResponse(feedPage([])));

    await renderFeed();

    expect(await screen.findByText('Nothing here yet')).toBeTruthy();
  });

  it('shows a retryable error state when the feed fails', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ detail: 'Something broke.' }, 500)
    );

    await renderFeed();

    expect(await screen.findByText('Couldn’t load your feed')).toBeTruthy();
    expect(screen.getByText('Try again')).toBeTruthy();
  });

  it('requests the group-merged feed when the preference is on (E3a/E4b)', async () => {
    // The preference (set in Settings, E4b) flips the feed request to
    // ?include_groups=1; the server does the chronological merge, so the client
    // just asks the other endpoint. With it on, the feed reads that variant.
    mockIncludeGroups = true;
    mockFetch.mockImplementation(async (url: string) =>
      String(url).includes('include_groups=1')
        ? jsonResponse(feedPage([makePost({ id: 2, text: 'From a group' })]))
        : jsonResponse(feedPage([makePost({ id: 1, text: 'Personal only' })]))
    );

    await renderFeed();

    expect(await screen.findByText('From a group')).toBeTruthy();
    expect(
      mockFetch.mock.calls.some(([u]) => String(u).includes('include_groups=1'))
    ).toBe(true);
  });

  it('requests the plain feed when the preference is off', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(feedPage([makePost({ id: 1, text: 'Personal only' })]))
    );

    await renderFeed();

    expect(await screen.findByText('Personal only')).toBeTruthy();
    expect(
      mockFetch.mock.calls.some(([u]) => String(u).includes('include_groups=1'))
    ).toBe(false);
  });

  it('marks an edited post', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(
        feedPage([
          makePost({ id: 1, text: 'Fixed a typo', edited_at: '2026-07-18T11:00:00Z' }),
        ])
      )
    );

    await renderFeed();

    // The marker is the transparency floor — see feed-and-posts.md.
    expect(await screen.findByText('· edited')).toBeTruthy();
  });

  it('shows reaction counts and the new-comment badge', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(
        feedPage([
          makePost({
            id: 1,
            reactions: [{ emoji: '👍', count: 3, reacted: true }],
            comment_count: 12,
            new_comment_count: 3,
          }),
        ])
      )
    );

    await renderFeed();

    expect(await screen.findByText('3')).toBeTruthy();
    expect(screen.getByText(/12 comments/)).toBeTruthy();
    expect(screen.getByText(/3 new/)).toBeTruthy();
  });
});

describe('pull-to-refresh trimming', () => {
  // `refetch()` on an infinite query refetches *every* loaded page, one after
  // another. Ten pages deep that's ten sequential requests over a phone
  // connection, for news that can only be on page one.
  function pages(count: number): FeedPages {
    return {
      pages: Array.from({ length: count }, (_, i) =>
        feedPage([makePost({ id: i + 1 })], i === count - 1 ? null : `?page=${i + 2}`)
      ),
      pageParams: Array.from({ length: count }, (_, i) => (i === 0 ? '' : `?page=${i + 1}`)),
    };
  }

  it('keeps only the first page and its param', () => {
    const trimmed = trimToFirstPage(pages(4));

    expect(trimmed!.pages).toHaveLength(1);
    expect(trimmed!.pageParams).toEqual(['']);
    // The page kept is the newest one, which is the only one that can have
    // gained posts.
    expect(trimmed!.pages[0].results[0].id).toBe(1);
  });

  it('declines to write when there is nothing to trim', () => {
    // `undefined` rather than the data back. Identity still matters — a new
    // object here would re-render the whole feed for no reason on every pull —
    // but declining does that *and* leaves an invalidation alone: handing back
    // the identical object is still a write, and a write resets `isInvalidated`
    // (#307). `lists.test.ts` pins that half.
    expect(trimToFirstPage(pages(1))).toBeUndefined();
    expect(trimToFirstPage(undefined)).toBeUndefined();
  });
});
