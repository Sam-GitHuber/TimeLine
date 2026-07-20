/**
 * Root layout: the providers every screen needs, plus the auth gate.
 *
 * Expo Router renders this around every route, so it is the app's one entry
 * point — the equivalent of `main.jsx` + `App.jsx` in the web app.
 */

import {
  QueryClient,
  QueryClientProvider,
  focusManager,
} from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { Stack, router, useRootNavigationState, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  AppState,
  type AppStateStatus,
  StyleSheet,
  View,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { api } from '@/api';
import { AuthProvider, useAuth } from '@/auth';
import { configureNotificationHandler, routeForNotification } from '@/push';
import { colors } from '@/theme';

// Module scope, not an effect: the handler decides whether a notification that
// arrives while the app is foregrounded is shown at all, and it has to be set
// before any notification can be delivered.
configureNotificationHandler();

/**
 * Created once at module scope, not inside the component: a QueryClient holds
 * the cache, so rebuilding it on a re-render would throw away every cached
 * response. Milestone C leans on this cache for the feed.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 401 is handled by the refresh path in `api.ts`; if a request still
      // fails after that the session is genuinely gone, so retrying is pointless
      // noise. Retry other failures once — phones drop connections constantly.
      retry: (failureCount, error) =>
        (error as { status?: number })?.status === 401 ? false : failureCount < 1,
    },
  },
});

/**
 * Sends the user to the right place when their auth state changes.
 *
 * Redirecting from an effect (rather than rendering one tree or the other) is
 * the pattern Expo Router documents: the router owns the URL, so pushing it
 * around keeps deep links working — which matters a lot in Milestone D, where a
 * tapped push notification has to land on a real route even from a cold start.
 */
function AuthGate() {
  const { status } = useAuth();
  const segments = useSegments();
  // Lives here rather than in RootLayout because it reads auth state, and so
  // must be inside AuthProvider.
  usePushNotificationTaps();
  // The router isn't ready to navigate on the very first render; navigating
  // before it is silently does nothing.
  const navigationState = useRootNavigationState();

  useEffect(() => {
    if (!navigationState?.key) return;
    if (status === 'loading') return;

    const onLoginScreen = segments[0] === 'login';

    if (status === 'signedOut' && !onLoginScreen) {
      router.replace('/login');
    } else if (status === 'signedIn' && onLoginScreen) {
      router.replace('/');
    }
  }, [status, segments, navigationState?.key]);

  if (status === 'loading') {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.surface },
      }}
    />
  );
}

/**
 * Tell TanStack Query when the app comes back to the foreground.
 *
 * Query's built-in refetch-on-focus listens for the browser's `visibilitychange`
 * event, which does not exist in React Native — so without this, **nothing ever
 * counts as a refocus** and a backgrounded app shows whatever it last fetched
 * until the user pulls to refresh.
 *
 * That matters more on a phone than on the web: people background an app for
 * hours and expect the feed to be current when they come back. It was visible
 * in testing — a post made while the app was backgrounded stayed missing after
 * reopening it.
 *
 * (Network reconnection is the sibling case, and needs `onlineManager` wired to
 * NetInfo. Deferred: it's another dependency, and v1 is deliberately online-only.)
 */
function useRefetchOnForeground() {
  useEffect(() => {
    const subscription = AppState.addEventListener(
      'change',
      (status: AppStateStatus) => focusManager.setFocused(status === 'active')
    );
    return () => subscription.remove();
  }, []);
}

/**
 * Open the right screen when a push notification is tapped.
 *
 * `useLastNotificationResponse` covers **both** cases in one API: a tap that
 * launched the app from cold, and one that arrives while it's already running.
 * The listener-only approach (`addNotificationResponseReceivedListener`) misses
 * the cold start entirely — the response fires before any listener is
 * mounted — which is the classic way this ships broken.
 *
 * Two guards matter:
 *
 * - **Dedupe by identifier.** The hook returns the *last* response, and keeps
 *   returning it on later re-renders; without the ref it would re-navigate
 *   every time something else changed.
 * - **Wait for auth.** A cold-start tap resolves before the token check does,
 *   and navigating then would race the auth gate's redirect to `/login`, so we
 *   hold the response until the user is known to be signed in.
 */
function usePushNotificationTaps() {
  const { status } = useAuth();
  const response = Notifications.useLastNotificationResponse();
  const navigationState = useRootNavigationState();
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (!response || status !== 'signedIn' || !navigationState?.key) return;

    const { identifier } = response.notification.request;
    if (handled.current === identifier) return;
    handled.current = identifier;

    const data = response.notification.request.content.data as {
      url?: string;
      notificationId?: number;
    };

    router.push(routeForNotification(data?.url));

    // Tapping a push counts as dealing with it, exactly as clicking a row in
    // the web dropdown does — so the activity centre and the badge stay in
    // step across devices. Best-effort: a failure here must not stop the
    // navigation that the user actually asked for.
    if (data?.notificationId) {
      api.markNotificationAddressed(data.notificationId).catch(() => {});
    }
  }, [response, status, navigationState?.key]);
}

export default function RootLayout() {
  useRefetchOnForeground();

  return (
    // GestureHandlerRootView must wrap the app for react-native-gesture-handler
    // to work (the avatar cropper's pinch/pan). It also re-roots inside its own
    // Modal, but wrapping here is the documented baseline and covers any future
    // gesture surface.
    <GestureHandlerRootView style={styles.root}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <StatusBar style="dark" />
          <AuthGate />
        </AuthProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
});
