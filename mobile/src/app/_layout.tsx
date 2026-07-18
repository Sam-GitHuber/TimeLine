/**
 * Root layout: the providers every screen needs, plus the auth gate.
 *
 * Expo Router renders this around every route, so it is the app's one entry
 * point — the equivalent of `main.jsx` + `App.jsx` in the web app.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack, router, useRootNavigationState, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { AuthProvider, useAuth } from '@/auth';
import { colors } from '@/theme';

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

export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <StatusBar style="dark" />
        <AuthGate />
      </AuthProvider>
    </QueryClientProvider>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
});
