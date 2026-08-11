/**
 * Acting on a push notification (Phase 9, Milestone D; Phase 9b M8).
 *
 * The cold-start path is the one the plan calls out as easy to get wrong and
 * easy to miss, so it is covered explicitly here rather than left to the
 * on-device pass: a cold-start tap resolves *before* the auth check finishes,
 * and navigating at that moment races the auth gate's redirect to /login.
 *
 * M8 adds **replying from the notification**. What can be tested here is the
 * decision — send this text to that conversation, navigate nowhere, and keep
 * the words if the send fails. Whether iOS actually draws a text field on a
 * pulled-down push is a device check (the category is registered natively), and
 * the plan says so.
 *
 * **How** it navigates matters as much as where (#177): every assertion here is
 * on `router.navigate`, because `router.push` stacked a fresh copy of the screen
 * a push targeted even when that screen was the one already on display.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { router, useRootNavigationState, useSegments } from 'expo-router';
import { render, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

import { api } from '@/api';
import { useAuth } from '@/auth';
import { clearOutbox, outboxFor } from '@/outbox';
import { REPLY_ACTION } from '@/push';
import { usePushNotificationTaps } from '@/usePushTaps';

jest.mock('expo-router', () => ({
  router: { navigate: jest.fn(), push: jest.fn(), replace: jest.fn() },
  useRootNavigationState: jest.fn(),
  useSegments: jest.fn(),
}));

jest.mock('@/auth', () => ({ useAuth: jest.fn() }));

const mockNotifications = Notifications as jest.Mocked<typeof Notifications>;
const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockNavState = useRootNavigationState as jest.MockedFunction<
  typeof useRootNavigationState
>;
const mockSegments = useSegments as jest.MockedFunction<typeof useSegments>;

/** A notification response as expo-notifications shapes it. */
function response({
  identifier = 'notif-1',
  url = '/p/42',
  notificationId = 7,
  actionIdentifier,
  userText,
}: {
  identifier?: string;
  url?: string;
  notificationId?: number;
  /** Set for an action response — `REPLY_ACTION` for a reply (M8). */
  actionIdentifier?: string;
  /** What was typed into the notification's text field. */
  userText?: string;
} = {}) {
  return {
    actionIdentifier,
    userText,
    notification: {
      request: {
        identifier,
        content: { data: { url, notificationId } },
      },
    },
  } as never;
}

/**
 * The hook reaches for a `QueryClient` to invalidate the counts behind the app
 * icon's badge (#179), so every render here needs a provider around it. Kept
 * inside `Probe` rather than at each call site so the existing tests read
 * exactly as they did.
 */
function Probe() {
  return (
    <QueryClientProvider client={client}>
      <Taps />
    </QueryClientProvider>
  );
}

function Taps() {
  usePushNotificationTaps();
  return <Text>probe</Text>;
}

let client: QueryClient;

/** The query keys `invalidateQueries` was asked for, flattened. */
function invalidated(): string[] {
  return (client.invalidateQueries as jest.Mock).mock.calls.flatMap(
    ([filters]) => filters?.queryKey ?? []
  );
}

beforeEach(() => {
  // `gcTime: 0` for the reason the other suites set it: an idle five-minute
  // collection timer keeps Node alive long after the suite has passed.
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  jest.spyOn(client, 'invalidateQueries');
  mockUseAuth.mockReturnValue({ status: 'signedIn' } as never);
  mockNavState.mockReturnValue({ key: 'root' } as never);
  // Somewhere in the app rather than on the login screen — the state every test
  // but the post-login one below is describing.
  mockSegments.mockReturnValue(['(tabs)'] as never);
  mockNotifications.useLastNotificationResponse.mockReturnValue(null as never);
  jest
    .spyOn(api, 'markNotificationAddressed')
    .mockResolvedValue(undefined as never);
  // Delivered push notifications (#178) — empty tray unless a test fills it.
  mockNotifications.getPresentedNotificationsAsync.mockReset();
  mockNotifications.getPresentedNotificationsAsync.mockResolvedValue([] as never);
  mockNotifications.dismissNotificationAsync.mockReset();
  mockNotifications.dismissNotificationAsync.mockResolvedValue(undefined as never);
  clearOutbox();
});

afterEach(() => {
  jest.restoreAllMocks();
});

it('navigates to the notification target when one is tapped', async () => {
  mockNotifications.useLastNotificationResponse.mockReturnValue(response());

  await render(<Probe />);

  await waitFor(() => expect(router.navigate).toHaveBeenCalledWith('/post/42'));
});

it('marks the notification addressed, matching the web click-through', async () => {
  mockNotifications.useLastNotificationResponse.mockReturnValue(
    response({ notificationId: 99 })
  );

  await render(<Probe />);

  await waitFor(() =>
    expect(api.markNotificationAddressed).toHaveBeenCalledWith(99)
  );
});

it('drops the unread count once the notification is addressed', async () => {
  // Addressed implies *seen* server-side (`NotificationAddressedView` sets
  // `seen_at` too), so tapping a push takes one off the bell — and off the app
  // icon (#179). Without this the icon went on claiming it for a poll cycle,
  // while the in-app click-through on the same row updated at once.
  mockNotifications.useLastNotificationResponse.mockReturnValue(
    response({ notificationId: 99 })
  );

  await render(<Probe />);

  await waitFor(() =>
    expect(invalidated()).toEqual(
      expect.arrayContaining(['notificationsUnread'])
    )
  );
});

it('leaves the count alone when marking addressed fails', async () => {
  // Nothing moved server-side, so the badge is still right — and a refetch
  // here would only overwrite a correct number with the same one.
  jest
    .spyOn(api, 'markNotificationAddressed')
    .mockRejectedValue(new Error('offline'));
  mockNotifications.useLastNotificationResponse.mockReturnValue(response());

  await render(<Probe />);

  await waitFor(() => expect(router.navigate).toHaveBeenCalled());
  expect(invalidated()).not.toContain('notificationsUnread');
});

it('still navigates when marking addressed fails', async () => {
  // The navigation is what the user asked for; a bookkeeping failure must not
  // swallow it.
  jest
    .spyOn(api, 'markNotificationAddressed')
    .mockRejectedValue(new Error('offline'));
  mockNotifications.useLastNotificationResponse.mockReturnValue(response());

  await render(<Probe />);

  await waitFor(() => expect(router.navigate).toHaveBeenCalledWith('/post/42'));
});

it('waits for sign-in before navigating on a cold start', async () => {
  // The cold-start case: the tap response is available immediately, but the
  // token check hasn't finished. Navigating now would race the auth gate's
  // redirect to /login and the deep link would be lost.
  mockUseAuth.mockReturnValue({ status: 'loading' } as never);
  mockNotifications.useLastNotificationResponse.mockReturnValue(response());

  const view = await render(<Probe />);
  expect(router.navigate).not.toHaveBeenCalled();

  // Auth resolves; the deep link is honoured rather than dropped.
  mockUseAuth.mockReturnValue({ status: 'signedIn' } as never);
  await view.rerender(<Probe />);

  await waitFor(() => expect(router.navigate).toHaveBeenCalledWith('/post/42'));
});

it('waits for the router to be ready', async () => {
  // Navigating before the root navigation state exists silently does nothing.
  mockNavState.mockReturnValue(undefined as never);
  mockNotifications.useLastNotificationResponse.mockReturnValue(response());

  await render(<Probe />);

  expect(router.navigate).not.toHaveBeenCalled();
});

it('holds a deep link until the login screen has gone (#220 §1)', async () => {
  // The *warm* half of the cold-start race above, and the one `status` alone
  // can't see. Tap a push while signed out, land on /login, sign in: the status
  // flips while /login is still the top screen, so in one render flush this
  // hook navigated to the target and AuthGate's redirect then replaced it with
  // the feed. `handled.current` was already set, so the deep link never came
  // back — you asked for Ada's thread and got the feed.
  mockSegments.mockReturnValue(['login'] as never);
  mockNotifications.useLastNotificationResponse.mockReturnValue(
    response({ url: '/messages/12', notificationId: undefined })
  );

  const view = await render(<Probe />);
  expect(router.navigate).not.toHaveBeenCalled();

  // AuthGate's post-login `router.replace('/')` has landed; now it's ours.
  mockSegments.mockReturnValue(['(tabs)'] as never);
  await view.rerender(<Probe />);

  await waitFor(() =>
    expect(router.navigate).toHaveBeenCalledWith('/messages/12')
  );
  expect(router.navigate).toHaveBeenCalledTimes(1);
});

it('holds a notification reply until the login screen has gone too', async () => {
  // Same guard, same reason as the router-readiness one it sits beside: one
  // definition of "ready to act on this", rather than two that can disagree
  // about a half-started app. Nothing is dropped — the response is still here
  // on the next render, and the reply goes out then.
  const send = jest.spyOn(api, 'sendMessage').mockResolvedValue({} as never);
  mockSegments.mockReturnValue(['login'] as never);
  mockNotifications.useLastNotificationResponse.mockReturnValue(
    response({
      url: '/messages/12',
      notificationId: undefined,
      actionIdentifier: REPLY_ACTION,
      userText: 'on my way',
    })
  );

  const view = await render(<Probe />);
  expect(send).not.toHaveBeenCalled();

  mockSegments.mockReturnValue(['(tabs)'] as never);
  await view.rerender(<Probe />);

  await waitFor(() => expect(send).toHaveBeenCalledWith(12, 'on my way'));
  expect(router.navigate).not.toHaveBeenCalled();
});

it('never navigates while signed out', async () => {
  mockUseAuth.mockReturnValue({ status: 'signedOut' } as never);
  mockNotifications.useLastNotificationResponse.mockReturnValue(response());

  await render(<Probe />);

  expect(router.navigate).not.toHaveBeenCalled();
});

it('handles a given notification only once across re-renders', async () => {
  // useLastNotificationResponse keeps returning the same response, so without
  // the dedupe ref every unrelated re-render would re-navigate.
  mockNotifications.useLastNotificationResponse.mockReturnValue(response());

  const view = await render(<Probe />);
  await waitFor(() => expect(router.navigate).toHaveBeenCalledTimes(1));

  await view.rerender(<Probe />);
  await view.rerender(<Probe />);

  expect(router.navigate).toHaveBeenCalledTimes(1);
});

it('navigates again for a genuinely different notification', async () => {
  mockNotifications.useLastNotificationResponse.mockReturnValue(response());
  const view = await render(<Probe />);
  await waitFor(() => expect(router.navigate).toHaveBeenCalledTimes(1));

  mockNotifications.useLastNotificationResponse.mockReturnValue(
    response({ identifier: 'notif-2', url: '/u/3' })
  );
  await view.rerender(<Probe />);

  await waitFor(() => expect(router.navigate).toHaveBeenCalledWith('/u/3'));
});

it('asks the router to collapse onto the target, not push a copy (#177)', async () => {
  // Two pushes for the *same* thread, tapped one after the other. The dedupe ref
  // above doesn't cover this and shouldn't: they're different notifications with
  // different identifiers, so both are acted on — which is exactly why the count
  // of duplicate screens used to track the count of pushes opened, and why Back
  // walked through copies of the thread instead of reaching the list.
  //
  // `router.push` is what stacked them: expo-router's PUSH appends a route with
  // no regard for what's already on top. **The collapsing itself is expo-router's**
  // (`getSingularId`) and is mocked away here, so this cannot see a stack — it
  // pins only the half that is ours, which is the half that regressed: the verb
  // a tapped push asks for. The stacking itself is a device check.
  // A message push carries no activity-centre row, hence no id (usePushTaps.ts).
  const notificationId = undefined;
  mockNotifications.useLastNotificationResponse.mockReturnValue(
    response({ identifier: 'notif-1', url: '/messages/5', notificationId })
  );
  const view = await render(<Probe />);
  await waitFor(() =>
    expect(router.navigate).toHaveBeenCalledWith('/messages/5')
  );

  mockNotifications.useLastNotificationResponse.mockReturnValue(
    response({ identifier: 'notif-2', url: '/messages/5', notificationId })
  );
  await view.rerender(<Probe />);

  await waitFor(() => expect(router.navigate).toHaveBeenCalledTimes(2));
  expect(router.navigate).toHaveBeenNthCalledWith(2, '/messages/5');
  expect(router.push).not.toHaveBeenCalled();
});

it('deep-links an event notification to its flat event screen (E3b)', async () => {
  // The backend sends the web's nested `/g/<id>/events/<id>`; mobile takes the
  // event id and opens the flat `/events/<id>` detail.
  mockNotifications.useLastNotificationResponse.mockReturnValue(
    response({ url: '/g/1/events/9' })
  );

  await render(<Probe />);

  await waitFor(() => expect(router.navigate).toHaveBeenCalledWith('/events/9'));
});

it('opens the app rather than crashing when the target has no screen yet', async () => {
  // A target whose screen isn't built yet (e.g. settings, Milestone E4) must
  // still open the app rather than crash it.
  mockNotifications.useLastNotificationResponse.mockReturnValue(
    response({ url: '/settings' })
  );

  await render(<Probe />);

  await waitFor(() => expect(router.navigate).toHaveBeenCalledWith('/'));
});


it('sends a reply typed into the notification, without opening the app', async () => {
  // The whole point of answering from the lock screen is that you don't end up
  // in the app — so this navigates nowhere.
  const send = jest.spyOn(api, 'sendMessage').mockResolvedValue({} as never);
  mockNotifications.useLastNotificationResponse.mockReturnValue(
    response({
      url: '/messages/12',
      notificationId: undefined,
      actionIdentifier: REPLY_ACTION,
      userText: '  on my way  ',
    })
  );

  await render(<Probe />);

  // Trimmed, like every other send.
  await waitFor(() => expect(send).toHaveBeenCalledWith(12, 'on my way'));
  expect(router.navigate).not.toHaveBeenCalled();
});

it('clears that thread’s other notifications once the reply lands (#178)', async () => {
  // Answering deals with the whole thread, not just the notification that was
  // pulled down — and this is the one dismissal path that runs with the app
  // deliberately *not* in the foreground, since `opensAppToForeground: false`
  // launches us in the background to handle the reply.
  jest.spyOn(api, 'sendMessage').mockResolvedValue({} as never);
  mockNotifications.getPresentedNotificationsAsync.mockResolvedValue([
    { request: { identifier: 'same-thread', content: { data: { url: '/messages/12' } } } },
    { request: { identifier: 'other-thread', content: { data: { url: '/messages/3' } } } },
  ] as never);
  mockNotifications.useLastNotificationResponse.mockReturnValue(
    response({
      url: '/messages/12',
      actionIdentifier: REPLY_ACTION,
      userText: 'on my way',
    })
  );

  await render(<Probe />);

  await waitFor(() =>
    expect(mockNotifications.dismissNotificationAsync).toHaveBeenCalledWith(
      'same-thread'
    )
  );
  expect(mockNotifications.dismissNotificationAsync).not.toHaveBeenCalledWith(
    'other-thread'
  );
});

it('takes the answered message off the app icon (#179)', async () => {
  // The one path that deals with a message while the app is deliberately *not*
  // in front of anyone — so the next thing the user sees is the home screen.
  // An icon still claiming the message they just answered is the most visible
  // possible version of the badge being wrong, which is why this path stopped
  // relying on "the app refetches on foreground".
  jest.spyOn(api, 'sendMessage').mockResolvedValue({} as never);
  mockNotifications.useLastNotificationResponse.mockReturnValue(
    response({
      url: '/messages/12',
      actionIdentifier: REPLY_ACTION,
      userText: 'on my way',
    })
  );

  await render(<Probe />);

  await waitFor(() =>
    expect(invalidated()).toEqual(expect.arrayContaining(['unreadMessages']))
  );
});

it('leaves the icon alone when the reply doesn’t land (#179)', async () => {
  // Same success-only rule as the dismissal beside it: a failed reply moved no
  // read marker, so the thread is still unread and the badge is still right.
  jest.spyOn(api, 'sendMessage').mockRejectedValue(new Error('offline'));
  mockNotifications.useLastNotificationResponse.mockReturnValue(
    response({
      url: '/messages/12',
      actionIdentifier: REPLY_ACTION,
      userText: 'on my way',
    })
  );

  await render(<Probe />);

  await waitFor(() => expect(api.sendMessage).toHaveBeenCalled());
  expect(invalidated()).not.toContain('unreadMessages');
});

it('keeps the notification when the reply doesn’t land (#178)', async () => {
  // The mirror of the case above, and the reason dismissal hangs off the
  // *success* path. A failed reply changes nothing server-side — the read
  // marker moves inside the send's transaction — so the thread is still unread,
  // and with no screen in front of anyone that notification is the only
  // remaining trace that something is waiting.
  jest.spyOn(api, 'sendMessage').mockRejectedValue(new Error('offline'));
  mockNotifications.getPresentedNotificationsAsync.mockResolvedValue([
    { request: { identifier: 'still-waiting', content: { data: { url: '/messages/12' } } } },
  ] as never);
  mockNotifications.useLastNotificationResponse.mockReturnValue(
    response({
      url: '/messages/12',
      actionIdentifier: REPLY_ACTION,
      userText: 'on my way',
    })
  );

  await render(<Probe />);

  // The outbox keeps the words; the notification keeps the prompt.
  await waitFor(() => expect(outboxFor(12)).toHaveLength(1));
  expect(mockNotifications.dismissNotificationAsync).not.toHaveBeenCalled();
});

it('keeps a reply that fails to send', async () => {
  // There's no screen to report on — by construction the app isn't in front of
  // anyone — so it goes into the outbox and shows up as a failed bubble with
  // Retry the next time the thread is opened. "We never drop text you typed"
  // applies to text typed into a notification too.
  jest.spyOn(api, 'sendMessage').mockRejectedValue(new Error('offline'));
  mockNotifications.useLastNotificationResponse.mockReturnValue(
    response({
      url: '/messages/12',
      actionIdentifier: REPLY_ACTION,
      userText: 'on my way',
    })
  );

  await render(<Probe />);

  await waitFor(() => {
    const [pending] = outboxFor(12);
    expect(pending?.text).toBe('on my way');
    expect(pending?.status).toBe('failed');
  });
});

it('sends nothing for an empty reply', async () => {
  const send = jest.spyOn(api, 'sendMessage').mockResolvedValue({} as never);
  mockNotifications.useLastNotificationResponse.mockReturnValue(
    response({
      url: '/messages/12',
      actionIdentifier: REPLY_ACTION,
      userText: '   ',
    })
  );

  await render(<Probe />);

  expect(send).not.toHaveBeenCalled();
  expect(router.navigate).not.toHaveBeenCalled();
});
