/**
 * Activity centre (Phase 9 E4c) — the in-app notification list + bell.
 *
 * What's pinned here is the wiring, not layout:
 *   - the list renders from the paginated GET, newest-first as the server sends;
 *   - opening the screen marks all unread *seen* (one POST, no ids) so the badge
 *     clears while the items stay;
 *   - tapping a row addresses it (POST) and deep-links via `routeForNotification`
 *     — the *same* map push taps use, so in-app and push click-through agree;
 *   - the bell badge reflects the unread count.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import type { ReactElement } from 'react';

import ActivityScreen from '@/app/activity';
import { ActivityBell } from '@/components/ActivityBell';
import type { Notification } from '@/types';

import { settle } from './helpers';

jest.mock('expo-router', () => ({
  router: {
    navigate: jest.fn(),
    push: jest.fn(),
    back: jest.fn(),
    replace: jest.fn(),
    canGoBack: () => true,
  },
}));

const mockRouter = router as unknown as {
  navigate: jest.Mock;
  push: jest.Mock;
  back: jest.Mock;
};

const mockNotifications = Notifications as jest.Mocked<typeof Notifications>;

const mockFetch = jest.fn();

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === null ? '' : JSON.stringify(body)),
    json: async () => body,
  };
}

function made(match: RegExp, method: string) {
  return mockFetch.mock.calls.some(
    ([url, init]) => match.test(String(url)) && (init?.method ?? 'GET') === method
  );
}

function requestBody(match: RegExp, method: string): unknown {
  const call = mockFetch.mock.calls.find(
    ([url, init]) => match.test(String(url)) && (init?.method ?? 'GET') === method
  );
  return call ? JSON.parse((call[1] as { body: string }).body) : undefined;
}

// RNTL v14 + React 19: the initial commit lands in a microtask, so the render
// must be awaited or `screen` is empty on the next synchronous line.
async function renderWithClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });
  await act(async () => {
    render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  });
}

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 1,
    kind: 'post_reply',
    actor: { id: 5, display_name: 'Ada Lovelace', avatar_thumb: null },
    text: 'Ada Lovelace replied to your post',
    target: { type: 'post', id: 42 },
    url: '/p/42',
    created_at: new Date().toISOString(),
    seen: false,
    addressed: false,
    ...overrides,
  };
}

// The list GET, with a fallback for the seen/addressed POSTs the screen fires.
function serveList(results: Notification[]) {
  servePages([results]);
}

/**
 * The list GET, served as `pages` — page one, then whatever `next` leads to.
 *
 * The `next` URL is absolute, as DRF's really is, so the app's `getPage`
 * host-stripping is exercised rather than assumed.
 */
function servePages(pages: Notification[][]) {
  const total = pages.reduce((n, page) => n + page.length, 0);
  mockFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    if (/\/api\/notifications\/(\?|$)/.test(url) && method === 'GET') {
      const index = Number(url.match(/[?&]page=(\d+)/)?.[1] ?? 1) - 1;
      return jsonResponse({
        count: total,
        next:
          index + 1 < pages.length
            ? `https://api.example.test/api/notifications/?page=${index + 2}`
            : null,
        results: pages[index] ?? [],
      });
    }
    // seen POST, addressed POST, unread-count GET — all fine to succeed.
    if (/unread-count/.test(url)) return jsonResponse({ count: 0 });
    return jsonResponse({ updated: 0 });
  });
}

/**
 * The list GET fails; everything else still answers.
 *
 * Deliberately *not* a variant of `servePages`, because the point of these
 * tests is that the seen POST and the dismissals are reachable and simply
 * mustn't be reached — a mock that refused them too would pass for the wrong
 * reason.
 */
function failList(status = 503, detail = 'Service unavailable.') {
  mockFetch.mockImplementation(async (url: string) => {
    if (/\/api\/notifications\/(\?|$)/.test(url)) {
      return jsonResponse({ detail }, status);
    }
    if (/unread-count/.test(url)) return jsonResponse({ count: 3 });
    return jsonResponse({ updated: 0 });
  });
}

function listGets() {
  return mockFetch.mock.calls
    .filter(([url, init]) => (init?.method ?? 'GET') === 'GET')
    .map(([url]) => String(url));
}

/**
 * Scroll to the bottom of the list, the way a thumb does.
 *
 * The layout and content-size events come first because `VirtualizedList` learns
 * its metrics only from events, and nothing measures itself under Node: a bare
 * scroll arrives at a list that believes it is zero pixels tall, and the
 * `onEndReached` guard bails before it looks at anything. (Same dance as the
 * transcript's paging test.)
 */
async function scrollToEnd() {
  const list = screen.getByTestId('activity-list');
  await fireEvent(list, 'layout', {
    nativeEvent: { layout: { height: 800, width: 400, x: 0, y: 0 } },
  });
  await fireEvent(list, 'contentSizeChange', 400, 2000);
  await fireEvent.scroll(list, {
    nativeEvent: {
      contentOffset: { y: 1200, x: 0 },
      contentSize: { height: 2000, width: 400 },
      layoutMeasurement: { height: 800, width: 400 },
    },
  });
}

beforeEach(() => {
  mockFetch.mockReset();
  mockRouter.navigate.mockReset();
  mockRouter.push.mockReset();
  mockRouter.back.mockReset();
  // Delivered push notifications (#178). Empty tray unless a test says
  // otherwise.
  mockNotifications.getPresentedNotificationsAsync.mockReset();
  mockNotifications.getPresentedNotificationsAsync.mockResolvedValue([] as never);
  mockNotifications.dismissNotificationAsync.mockReset();
  mockNotifications.dismissNotificationAsync.mockResolvedValue(undefined as never);
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(async () => {
  cleanup();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe('ActivityScreen', () => {
  it('renders the notification list from the GET', async () => {
    serveList([
      notification({ id: 1, text: 'Ada replied to your post' }),
      notification({ id: 2, text: 'Grace reacted to your comment', seen: true }),
    ]);
    await renderWithClient(<ActivityScreen />);

    expect(await screen.findByText('Ada replied to your post')).toBeTruthy();
    expect(screen.getByText('Grace reacted to your comment')).toBeTruthy();
  });

  it('marks all unread seen on open (one POST, no ids)', async () => {
    serveList([notification()]);
    await renderWithClient(<ActivityScreen />);

    await waitFor(() =>
      expect(made(/\/api\/notifications\/seen\/$/, 'POST')).toBe(true)
    );
    // No `ids` — the empty body means "mark every unread seen".
    expect(requestBody(/\/api\/notifications\/seen\/$/, 'POST')).toEqual({});
  });

  it('takes back the OS notifications behind those rows (#178)', async () => {
    // The screen's whole design is that a notification is *kept* in-app while
    // its badge signal is cleared — and one sitting in the phone's notification
    // centre is a badge signal. A message push must survive it: messaging keeps
    // its own unread badge and is deliberately outside the bell, and its push
    // carries no `notificationId`, which is what tells the two apart here.
    serveList([notification()]);
    mockNotifications.getPresentedNotificationsAsync.mockResolvedValue([
      { request: { identifier: 'bell', content: { data: { url: '/p/42', notificationId: 1 } } } },
      {
        request: {
          identifier: 'message',
          content: { data: { url: '/messages/5', notificationId: null } },
        },
      },
    ] as never);

    await renderWithClient(<ActivityScreen />);

    await waitFor(() =>
      expect(mockNotifications.dismissNotificationAsync).toHaveBeenCalledWith('bell')
    );
    expect(mockNotifications.dismissNotificationAsync).not.toHaveBeenCalledWith(
      'message'
    );
  });

  it('addresses a row and deep-links to its mapped route on tap', async () => {
    serveList([notification({ id: 7, url: '/p/42', text: 'Reply on your post' })]);
    await renderWithClient(<ActivityScreen />);

    await fireEvent.press(await screen.findByText('Reply on your post'));

    await waitFor(() =>
      expect(made(/\/api\/notifications\/7\/addressed\/$/, 'POST')).toBe(true)
    );
    // `/p/42` (web shape) is mapped to the mobile post route, the same map push
    // taps use — not the raw web path.
    expect(mockRouter.navigate).toHaveBeenCalledWith('/post/42');
  });

  it('maps an event notification through the flat mobile route', async () => {
    serveList([
      notification({
        id: 8,
        kind: 'event_scheduled',
        url: '/g/3/events/9',
        text: 'Event scheduled',
      }),
    ]);
    await renderWithClient(<ActivityScreen />);

    await fireEvent.press(await screen.findByText('Event scheduled'));

    await waitFor(() => expect(mockRouter.navigate).toHaveBeenCalledWith('/events/9'));
  });

  it('does not re-address an already-addressed row, but still navigates', async () => {
    serveList([
      notification({ id: 9, addressed: true, seen: true, url: '/u/5', text: 'Ada accepted' }),
    ]);
    await renderWithClient(<ActivityScreen />);

    await fireEvent.press(await screen.findByText('Ada accepted'));

    await waitFor(() => expect(mockRouter.navigate).toHaveBeenCalledWith('/u/5'));
    expect(made(/\/api\/notifications\/9\/addressed\/$/, 'POST')).toBe(false);
  });

  it('pages older notifications in when you reach the end (#134)', async () => {
    // The defect. The screen rendered `results` and stopped, so everything past
    // page one was unreachable.
    servePages([
      [
        notification({ id: 1, text: 'Newest' }),
        notification({ id: 2, text: 'Middle' }),
      ],
      [notification({ id: 3, text: 'Oldest' })],
    ]);
    await renderWithClient(<ActivityScreen />);

    expect(await screen.findByText('Newest')).toBeTruthy();
    // Page one only, until asked for more.
    expect(screen.queryByText('Oldest')).toBeNull();
    expect(listGets().some((url) => url.includes('page='))).toBe(false);

    await scrollToEnd();

    expect(await screen.findByText('Oldest')).toBeTruthy();
    // Followed the paginator's `next` — and the absolute URL it came as was
    // re-based on our own host rather than requested as-is.
    expect(
      listGets().some((url) => url.endsWith('/api/notifications/?page=2'))
    ).toBe(true);
    expect(listGets().some((url) => url.includes('api.example.test'))).toBe(false);
  });

  it('renders a row once when paging re-sends it', async () => {
    // Page two can re-send a row page one already showed. Two rows with one key
    // is a React warning and a recycled-wrong cell.
    servePages([
      [notification({ id: 1, text: 'Newest' }), notification({ id: 2, text: 'Middle' })],
      [notification({ id: 2, text: 'Middle' }), notification({ id: 3, text: 'Oldest' })],
    ]);
    await renderWithClient(<ActivityScreen />);
    await screen.findByText('Newest');

    await scrollToEnd();

    expect(await screen.findByText('Oldest')).toBeTruthy();
    expect(screen.getAllByText('Middle')).toHaveLength(1);
  });

  it('drops back to one page when you leave the screen', async () => {
    // The ['notifications'] cache outlives this screen, so a second visit would
    // otherwise refetch every page the first visit scrolled through — including
    // through the seen-on-open invalidation — for rows nobody is looking at.
    servePages([
      [notification({ id: 1, text: 'Newest' })],
      [notification({ id: 2, text: 'Oldest' })],
    ]);
    // `gcTime: Infinity`, unlike the other tests here, because the cache
    // surviving the screen is the whole premise — with the usual `0` the entry
    // is collected on unmount and there'd be nothing to assert about. Infinity
    // also schedules no timer, so nothing is left holding the run open.
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity },
        mutations: { gcTime: 0 },
      },
    });
    let view!: Awaited<ReturnType<typeof render>>;
    await act(async () => {
      view = await render(
        <QueryClientProvider client={queryClient}>
          <ActivityScreen />
        </QueryClientProvider>
      );
    });
    await screen.findByText('Newest');
    await scrollToEnd();
    await screen.findByText('Oldest');
    expect(
      (queryClient.getQueryData(['notifications']) as { pages: unknown[] }).pages
    ).toHaveLength(2);

    await act(async () => {
      await view.unmount();
    });

    // Page two is gone, so the next visit starts at the top with one request.
    expect(
      (queryClient.getQueryData(['notifications']) as { pages: unknown[] }).pages
    ).toHaveLength(1);
    queryClient.clear();
  });

  it('shows the empty state when there are no notifications', async () => {
    serveList([]);
    await renderWithClient(<ActivityScreen />);

    expect(await screen.findByText(/all caught up/i)).toBeTruthy();
  });

  /**
   * A failed load is not an answer (#312).
   *
   * The screen read no error flag at all: `data` came back undefined, the
   * flattened array fell to `[]`, and "You're all caught up" — a flat statement
   * of fact — rendered on the strength of a request that never arrived. Losing
   * signal does it, and so does catching the box mid-restart, which is what
   * publishing a GitHub Release does (`deploy.md`).
   */
  describe('when the list fails to load', () => {
    it('says so instead of claiming you are all caught up', async () => {
      failList();
      await renderWithClient(<ActivityScreen />);

      expect(await screen.findByText(/Couldn’t load your activity/)).toBeTruthy();
      // The server's own sentence, not a synthesized one.
      expect(screen.getByText('Service unavailable.')).toBeTruthy();
      expect(screen.queryByText(/all caught up/i)).toBeNull();
    });

    it('does not mark everything seen, or clear the shade', async () => {
      // The costly half. The mount effect fired the POST regardless of whether
      // the list landed, so a failed open both said "all caught up" *and*
      // cleared every unread server-side — killing the badge that would have
      // brought the reader back, having just told them there was nothing to
      // come back for.
      failList();
      mockNotifications.getPresentedNotificationsAsync.mockResolvedValue([
        {
          request: {
            identifier: 'bell',
            content: { data: { url: '/p/42', notificationId: 1 } },
          },
        },
      ] as never);

      await renderWithClient(<ActivityScreen />);
      await screen.findByText(/Couldn’t load your activity/);

      expect(made(/\/api\/notifications\/seen\/$/, 'POST')).toBe(false);
      expect(mockNotifications.dismissNotificationAsync).not.toHaveBeenCalled();
    });

    it('loads the list, and marks it seen, when Try again works', async () => {
      // The write is deferred, not abandoned: it rides whichever read finally
      // puts the rows on screen.
      failList();
      await renderWithClient(<ActivityScreen />);
      await screen.findByText(/Couldn’t load your activity/);

      serveList([notification({ id: 1, text: 'Ada replied to your post' })]);
      await fireEvent.press(screen.getByText('Try again'));

      expect(await screen.findByText('Ada replied to your post')).toBeTruthy();
      await waitFor(() =>
        expect(made(/\/api\/notifications\/seen\/$/, 'POST')).toBe(true)
      );
    });
  });

  it('keeps the rows, and still marks them seen, when a refresh fails', async () => {
    // The other side of the same rule: a warm list whose refetch failed is
    // still a screen full of notifications the reader is looking at, and those
    // have been seen. (The rows surviving is structural — the error branch
    // lives in `ListEmptyComponent`, which can't render while there are rows.
    // The test below is the one that pins `!listLoaded`.)
    servePages([[notification({ id: 1, text: 'Ada replied to your post' })]]);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { gcTime: 0 },
      },
    });
    await act(async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <ActivityScreen />
        </QueryClientProvider>
      );
    });
    await screen.findByText('Ada replied to your post');

    failList();
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
    });
    // The cache flips to 'error' a render before the screen does — React Query
    // notifies through `notifyManager` on a macrotask — so without this the
    // assertions below read the pre-error tree and pass against a screen with
    // the bug still in it. The shared `settle`, not a hand-rolled flush: its
    // docblock says the hand-written copy is the one that's subtly wrong, and
    // this file had no other reason to own one.
    await settle(2);

    expect(screen.getByText('Ada replied to your post')).toBeTruthy();
    expect(made(/\/api\/notifications\/seen\/$/, 'POST')).toBe(true);
  });

  it('still says you are caught up when an empty list fails to refresh', async () => {
    // The case that actually pins `isError && !listLoaded` rather than a bare
    // `isError` — and the only one that can, because the error branch lives in
    // `ListEmptyComponent`: while there are rows it cannot render whatever the
    // flag says, so a list with rows in it proves nothing about the guard.
    //
    // Someone who genuinely has no notifications, whose next poll drops, must
    // still be told they're caught up. Answering "couldn't load your activity"
    // there is the mirror of the bug this PR fixes — a failed refresh reported
    // as the state of the world.
    servePages([[]]);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { gcTime: 0 },
      },
    });
    await act(async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <ActivityScreen />
        </QueryClientProvider>
      );
    });
    await screen.findByText(/all caught up/i);

    failList();
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
    });
    await settle(2);

    expect(screen.getByText(/all caught up/i)).toBeTruthy();
    expect(screen.queryByText(/Couldn’t load your activity/)).toBeNull();
  });
});

describe('ActivityBell', () => {
  it('shows the unread count and opens the activity screen', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ count: 3 }));
    await renderWithClient(<ActivityBell />);

    expect(await screen.findByText('3')).toBeTruthy();

    await fireEvent.press(screen.getByLabelText('Activity, 3 unread'));
    expect(mockRouter.push).toHaveBeenCalledWith('/activity');
  });

  it('renders no badge when nothing is unread', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ count: 0 }));
    await renderWithClient(<ActivityBell />);

    // The button is still there (labelled plainly), but no count pill.
    expect(await screen.findByLabelText('Activity')).toBeTruthy();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('caps a large unread count at 99+', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ count: 250 }));
    await renderWithClient(<ActivityBell />);

    expect(await screen.findByText('99+')).toBeTruthy();
  });
});
