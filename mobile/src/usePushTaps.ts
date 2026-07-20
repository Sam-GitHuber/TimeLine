/**
 * Open the right screen when a push notification is tapped (Phase 9, D).
 *
 * Its own module rather than living in `_layout.tsx` so it can be tested
 * directly — the cold-start path is the one the plan singles out as easy to
 * get wrong, and it is not something a manual pass reliably catches.
 *
 * `useLastNotificationResponse` covers **both** cases in one API: a tap that
 * launched the app from cold, and one that arrives while it is already
 * running. The listener-only approach
 * (`addNotificationResponseReceivedListener`) misses the cold start entirely —
 * the response fires before any listener is mounted — which is the classic way
 * this ships broken.
 */

import * as Notifications from 'expo-notifications';
import { router, useRootNavigationState } from 'expo-router';
import { useEffect, useRef } from 'react';

import { api } from '@/api';
import { useAuth } from '@/auth';
import { routeForNotification } from '@/push';

export function usePushNotificationTaps(): void {
  const { status } = useAuth();
  const response = Notifications.useLastNotificationResponse();
  const navigationState = useRootNavigationState();
  const handled = useRef<string | null>(null);

  useEffect(() => {
    // Three reasons to hold off, all of which resolve later:
    //  - no response yet;
    //  - not signed in — a cold-start tap resolves before the token check
    //    does, and navigating now would race the auth gate's redirect to
    //    /login and lose the deep link;
    //  - the router isn't ready, where navigation silently no-ops.
    if (!response || status !== 'signedIn' || !navigationState?.key) return;

    const { identifier } = response.notification.request;
    // The hook keeps returning the *same* response on later re-renders, so
    // without this it would re-navigate every time anything else changed.
    if (handled.current === identifier) return;
    handled.current = identifier;

    const data = response.notification.request.content.data as {
      url?: string;
      notificationId?: number;
    };

    router.push(routeForNotification(data?.url));

    // Tapping a push counts as dealing with it, exactly as clicking a row in
    // the web dropdown does — so the activity centre and the badge stay in
    // step across devices. Best-effort: a failure here must not undo the
    // navigation the user actually asked for.
    if (data?.notificationId) {
      api.markNotificationAddressed(data.notificationId).catch(() => {});
    }
  }, [response, status, navigationState?.key]);
}
