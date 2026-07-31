/**
 * Taking notifications back once they've been dealt with in the app (#178).
 *
 * Push notifications used to be write-only: once delivered, one sat in the
 * phone's notification centre until it was tapped or swiped, however thoroughly
 * you had since read it in the app. What's pinned here is the *decision* in each
 * case — which delivered notifications a given action clears, and just as
 * importantly which it must leave alone:
 *
 *   - reading a thread clears that thread's, and no one else's;
 *   - opening the activity centre clears the bell's, and **not** message pushes
 *     (they carry no `notificationId`, which is the only thing distinguishing
 *     them down at tray level);
 *   - a message for the thread you're looking at doesn't get filed in the
 *     notification centre at all;
 *   - coming back to the foreground clears whatever was read elsewhere — and
 *     spends no network request when there's nothing in the tray to clean.
 *
 * Every path here swallows its failures, so the failure cases are pinned too:
 * an unreachable tray must not surface as a rejection into a screen. The worst
 * a broken dismissal may do is leave the notification where it was.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react-native';
import * as Notifications from 'expo-notifications';
import { AppState } from 'react-native';

import { api } from '@/api';
import { useAuth } from '@/auth';
import {
  configureNotificationHandler,
  dismissActivityNotifications,
  dismissConversationNotifications,
  presentedConversationIds,
  setOnScreenConversation,
} from '@/push';
import { usePushDismissals } from '@/usePushDismissals';

jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  getPresentedNotificationsAsync: jest.fn(async () => []),
  dismissNotificationAsync: jest.fn(async () => {}),
  // Read at module scope by the channel table, so it has to exist even though
  // nothing here touches channels.
  AndroidImportance: { HIGH: 4, DEFAULT: 3, LOW: 2 },
}));

jest.mock('@/auth', () => ({ useAuth: jest.fn() }));

const mockNotifications = Notifications as jest.Mocked<typeof Notifications>;
const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;

/**
 * A notification as it sits in the tray. `url` + `notificationId` are the whole
 * of what the backend gives us to identify one by (`send_pushes.py`).
 */
function presented(
  identifier: string,
  data: { url?: string | null; notificationId?: number | null }
) {
  return { request: { identifier, content: { data } } };
}

/** What's currently in the tray. */
function tray(...notifications: ReturnType<typeof presented>[]) {
  mockNotifications.getPresentedNotificationsAsync.mockResolvedValue(
    notifications as never
  );
}

/** The identifiers `dismissNotificationAsync` was called with, in any order. */
function dismissed(): string[] {
  return mockNotifications.dismissNotificationAsync.mock.calls
    .map(([identifier]) => identifier)
    .sort();
}

beforeEach(() => {
  setOnScreenConversation(null);
  mockNotifications.getPresentedNotificationsAsync.mockResolvedValue([] as never);
  mockNotifications.dismissNotificationAsync.mockResolvedValue(undefined as never);
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('dismissing a conversation’s notifications', () => {
  it('clears that thread’s, and leaves every other notification alone', async () => {
    tray(
      presented('a', { url: '/messages/5', notificationId: null }),
      presented('b', { url: '/messages/5', notificationId: null }),
      presented('c', { url: '/messages/9', notificationId: null }),
      presented('d', { url: '/p/42', notificationId: 7 })
    );

    await dismissConversationNotifications([5]);

    expect(dismissed()).toEqual(['a', 'b']);
  });

  it('clears several conversations at once, for the foreground reconcile', async () => {
    tray(
      presented('a', { url: '/messages/5' }),
      presented('b', { url: '/messages/9' }),
      presented('c', { url: '/messages/12' })
    );

    await dismissConversationNotifications([5, 12]);

    expect(dismissed()).toEqual(['a', 'c']);
  });

  it('does not even read the tray when asked to clear nothing', async () => {
    await dismissConversationNotifications([]);

    expect(mockNotifications.getPresentedNotificationsAsync).not.toHaveBeenCalled();
  });

  it('survives a tray that can’t be read', async () => {
    mockNotifications.getPresentedNotificationsAsync.mockRejectedValue(
      new Error('no notification access')
    );

    await expect(dismissConversationNotifications([5])).resolves.toBeUndefined();
  });

  it('survives a dismissal that fails', async () => {
    tray(presented('a', { url: '/messages/5' }));
    mockNotifications.dismissNotificationAsync.mockRejectedValue(
      new Error('gone')
    );

    await expect(dismissConversationNotifications([5])).resolves.toBeUndefined();
  });
});

describe('dismissing the activity centre’s notifications', () => {
  it('clears everything the bell counts', async () => {
    tray(
      presented('a', { url: '/p/42', notificationId: 7 }),
      presented('b', { url: '/u/3', notificationId: 8 })
    );

    await dismissActivityNotifications();

    expect(dismissed()).toEqual(['a', 'b']);
  });

  it('leaves message pushes alone — messaging is outside the bell', async () => {
    tray(
      presented('a', { url: '/messages/5', notificationId: null }),
      presented('b', { url: '/p/42', notificationId: 7 })
    );

    await dismissActivityNotifications();

    expect(dismissed()).toEqual(['b']);
  });
});

describe('presentedConversationIds', () => {
  it('reports the conversations waiting in the tray, deduplicated', async () => {
    tray(
      presented('a', { url: '/messages/5' }),
      presented('b', { url: '/messages/5' }),
      presented('c', { url: '/p/42', notificationId: 7 }),
      presented('d', {})
    );

    expect(await presentedConversationIds()).toEqual(new Set([5]));
  });

  it('treats an unreadable tray as an empty one', async () => {
    mockNotifications.getPresentedNotificationsAsync.mockRejectedValue(
      new Error('no notification access')
    );

    expect(await presentedConversationIds()).toEqual(new Set());
  });
});

describe('a message arriving while its thread is on screen', () => {
  /** Run the registered foreground handler against one notification. */
  async function present(data: { url?: string | null }) {
    configureNotificationHandler();
    const [handler] = mockNotifications.setNotificationHandler.mock.calls.at(-1)!;
    return handler!.handleNotification!({
      request: { content: { data } },
    } as never);
  }

  it('banners but is not filed in the notification centre', async () => {
    setOnScreenConversation(5);

    const behaviour = await present({ url: '/messages/5' });

    expect(behaviour).toMatchObject({
      shouldShowBanner: true,
      shouldShowList: false,
    });
  });

  it('is filed as normal when it’s for a different thread', async () => {
    setOnScreenConversation(5);

    expect(await present({ url: '/messages/9' })).toMatchObject({
      shouldShowList: true,
    });
    expect(await present({ url: '/p/42' })).toMatchObject({
      shouldShowList: true,
    });
  });

  it('is filed as normal once that thread is no longer on screen', async () => {
    setOnScreenConversation(5);
    setOnScreenConversation(null);

    expect(await present({ url: '/messages/5' })).toMatchObject({
      shouldShowList: true,
    });
  });
});

describe('reconciling on foreground', () => {
  function Harness() {
    usePushDismissals();
    return null;
  }

  function renderHarness() {
    // `gcTime: 0` is about the *test runner*, not the assertions. The reconcile
    // fetches through `fetchQuery`, which leaves a query with no observers
    // behind it, and Query schedules its garbage collection five minutes out —
    // a live timer that keeps Node alive long after the suite has passed, so
    // Jest sits there refusing to exit. Collecting immediately drops it.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>
    );
  }

  /** The AppState listener the hook subscribed with, once it has. */
  let listener: ((status: string) => void) | undefined;

  beforeEach(() => {
    listener = undefined;
    mockUseAuth.mockReturnValue({ status: 'signedIn' } as never);
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation(((_event: string, handler: (s: string) => void) => {
        listener = handler;
        return { remove: jest.fn() };
      }) as never);
  });

  /** One turn of the event loop, for effects to run in. */
  function tick() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  /**
   * Mount the hook and bring the app to the foreground.
   *
   * Both waits are load-bearing. Effects flush *after* `render` returns, so
   * without the first there is no listener to call yet. The second gives the
   * reconcile — which is several awaits deep — a real tick to finish in, so
   * each test can assert on a settled world instead of polling for one.
   */
  async function foreground() {
    renderHarness();
    await tick();
    expect(listener).toBeDefined();
    await act(async () => {
      listener!('active');
      await tick();
    });
  }

  function conversations(...rows: { id: number; unread_count: number }[]) {
    return jest
      .spyOn(api, 'getConversations')
      .mockResolvedValue({ results: rows } as never);
  }

  it('clears notifications for threads that are no longer unread', async () => {
    tray(
      presented('a', { url: '/messages/5' }),
      presented('b', { url: '/messages/9' })
    );
    conversations({ id: 5, unread_count: 0 }, { id: 9, unread_count: 2 });

    await foreground();

    expect(dismissed()).toEqual(['a']);
  });

  it('spends no request when the tray is empty', async () => {
    const getConversations = conversations({ id: 5, unread_count: 0 });

    await foreground();

    expect(mockNotifications.getPresentedNotificationsAsync).toHaveBeenCalled();
    expect(getConversations).not.toHaveBeenCalled();
    expect(mockNotifications.dismissNotificationAsync).not.toHaveBeenCalled();
  });

  it('leaves a thread it can’t see on the first page of conversations', async () => {
    tray(presented('a', { url: '/messages/77' }));
    conversations({ id: 5, unread_count: 0 });

    await foreground();

    expect(api.getConversations).toHaveBeenCalled();
    expect(mockNotifications.dismissNotificationAsync).not.toHaveBeenCalled();
  });

  it('survives the conversation fetch failing', async () => {
    tray(presented('a', { url: '/messages/5' }));
    jest
      .spyOn(api, 'getConversations')
      .mockRejectedValue(Object.assign(new Error('offline'), { status: 500 }));

    await foreground();

    expect(api.getConversations).toHaveBeenCalled();
    expect(mockNotifications.dismissNotificationAsync).not.toHaveBeenCalled();
  });

  it('does not subscribe at all while signed out', async () => {
    mockUseAuth.mockReturnValue({ status: 'signedOut' } as never);

    renderHarness();
    // The same tick the signed-in path needs before its listener exists —
    // load-bearing here because the assertion is a *negative* one, and without
    // it would pass whether or not the hook subscribed.
    await tick();

    expect(AppState.addEventListener).not.toHaveBeenCalled();
  });
});
