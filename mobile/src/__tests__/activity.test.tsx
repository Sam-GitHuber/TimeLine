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
  mockFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    if (/\/api\/notifications\/$/.test(url) && method === 'GET') {
      return jsonResponse({ count: results.length, next: null, results });
    }
    // seen POST, addressed POST, unread-count GET — all fine to succeed.
    if (/unread-count/.test(url)) return jsonResponse({ count: 0 });
    return jsonResponse({ updated: 0 });
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

  it('shows the empty state when there are no notifications', async () => {
    serveList([]);
    await renderWithClient(<ActivityScreen />);

    expect(await screen.findByText(/all caught up/i)).toBeTruthy();
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
