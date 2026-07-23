/**
 * Tapping a push notification (Phase 9, Milestone D).
 *
 * The cold-start path is the one the plan calls out as easy to get wrong and
 * easy to miss, so it is covered explicitly here rather than left to the
 * on-device pass: a cold-start tap resolves *before* the auth check finishes,
 * and navigating at that moment races the auth gate's redirect to /login.
 */

import * as Notifications from 'expo-notifications';
import { router, useRootNavigationState } from 'expo-router';
import { render, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

import { api } from '@/api';
import { useAuth } from '@/auth';
import { usePushNotificationTaps } from '@/usePushTaps';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn() },
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
}: { identifier?: string; url?: string; notificationId?: number } = {}) {
  return {
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
});

afterEach(() => {
  jest.restoreAllMocks();
});

it('navigates to the notification target when one is tapped', async () => {
  mockNotifications.useLastNotificationResponse.mockReturnValue(response());

  await render(<Probe />);

  await waitFor(() => expect(router.push).toHaveBeenCalledWith('/post/42'));
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

  await waitFor(() => expect(router.push).toHaveBeenCalledWith('/post/42'));
});

it('waits for sign-in before navigating on a cold start', async () => {
  // The cold-start case: the tap response is available immediately, but the
  // token check hasn't finished. Navigating now would race the auth gate's
  // redirect to /login and the deep link would be lost.
  mockUseAuth.mockReturnValue({ status: 'loading' } as never);
  mockNotifications.useLastNotificationResponse.mockReturnValue(response());

  const view = await render(<Probe />);
  expect(router.push).not.toHaveBeenCalled();

  // Auth resolves; the deep link is honoured rather than dropped.
  mockUseAuth.mockReturnValue({ status: 'signedIn' } as never);
  await view.rerender(<Probe />);

  await waitFor(() => expect(router.push).toHaveBeenCalledWith('/post/42'));
});

it('waits for the router to be ready', async () => {
  // Navigating before the root navigation state exists silently does nothing.
  mockNavState.mockReturnValue(undefined as never);
  mockNotifications.useLastNotificationResponse.mockReturnValue(response());

  await render(<Probe />);

  expect(router.push).not.toHaveBeenCalled();
});

it('never navigates while signed out', async () => {
  mockUseAuth.mockReturnValue({ status: 'signedOut' } as never);
  mockNotifications.useLastNotificationResponse.mockReturnValue(response());

  await render(<Probe />);

  expect(router.push).not.toHaveBeenCalled();
});

it('handles a given notification only once across re-renders', async () => {
  // useLastNotificationResponse keeps returning the same response, so without
  // the dedupe ref every unrelated re-render would re-navigate.
  mockNotifications.useLastNotificationResponse.mockReturnValue(response());

  const view = await render(<Probe />);
  await waitFor(() => expect(router.push).toHaveBeenCalledTimes(1));

  await view.rerender(<Probe />);
  await view.rerender(<Probe />);

  expect(router.push).toHaveBeenCalledTimes(1);
});

it('navigates again for a genuinely different notification', async () => {
  mockNotifications.useLastNotificationResponse.mockReturnValue(response());
  const view = await render(<Probe />);
  await waitFor(() => expect(router.push).toHaveBeenCalledTimes(1));

  mockNotifications.useLastNotificationResponse.mockReturnValue(
    response({ identifier: 'notif-2', url: '/u/3' })
  );
  await view.rerender(<Probe />);

  await waitFor(() => expect(router.push).toHaveBeenCalledWith('/u/3'));
});

it('deep-links an event notification to its flat event screen (E3b)', async () => {
  // The backend sends the web's nested `/g/<id>/events/<id>`; mobile takes the
  // event id and opens the flat `/events/<id>` detail.
  mockNotifications.useLastNotificationResponse.mockReturnValue(
    response({ url: '/g/1/events/9' })
  );

  await render(<Probe />);

  await waitFor(() => expect(router.push).toHaveBeenCalledWith('/events/9'));
});

it('opens the app rather than crashing when the target has no screen yet', async () => {
  // A target whose screen isn't built yet (e.g. settings, Milestone E4) must
  // still open the app rather than crash it.
  mockNotifications.useLastNotificationResponse.mockReturnValue(
    response({ url: '/settings' })
  );

  await render(<Probe />);

  await waitFor(() => expect(router.push).toHaveBeenCalledWith('/'));
});
