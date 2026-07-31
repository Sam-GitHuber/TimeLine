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

import * as Notifications from 'expo-notifications';
import { router, useRootNavigationState } from 'expo-router';
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
}));

jest.mock('@/auth', () => ({ useAuth: jest.fn() }));

const mockNotifications = Notifications as jest.Mocked<typeof Notifications>;
const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockNavState = useRootNavigationState as jest.MockedFunction<
  typeof useRootNavigationState
>;

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

function Probe() {
  usePushNotificationTaps();
  return <Text>probe</Text>;
}

beforeEach(() => {
  mockUseAuth.mockReturnValue({ status: 'signedIn' } as never);
  mockNavState.mockReturnValue({ key: 'root' } as never);
  mockNotifications.useLastNotificationResponse.mockReturnValue(null as never);
  jest
    .spyOn(api, 'markNotificationAddressed')
    .mockResolvedValue(undefined as never);
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

it('never stacks a second copy of the screen a push targets (#177)', async () => {
  // Two pushes for the *same* thread, tapped one after the other. The dedupe ref
  // above doesn't cover this and shouldn't: they're different notifications with
  // different identifiers, so both are acted on — which is exactly why the count
  // of duplicate screens used to track the count of pushes opened, and why Back
  // walked through copies of the thread instead of reaching the list.
  //
  // `router.push` is what stacked them: expo-router's PUSH appends a route with
  // no regard for what's already on top. `navigate` collapses onto the current
  // screen when the route name and its path params match. The collapsing itself
  // belongs to expo-router (`getSingularId`), so what's pinned here is the half
  // that's ours: a tapped push never asks for an unconditional push.
  mockNotifications.useLastNotificationResponse.mockReturnValue(
    response({ identifier: 'notif-1', url: '/messages/5' })
  );
  const view = await render(<Probe />);
  await waitFor(() =>
    expect(router.navigate).toHaveBeenCalledWith('/messages/5')
  );

  mockNotifications.useLastNotificationResponse.mockReturnValue(
    response({ identifier: 'notif-2', url: '/messages/5' })
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
