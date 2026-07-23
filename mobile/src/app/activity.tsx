/**
 * The activity centre (Phase 9 E4c) — the unified "something happened to you"
 * list, ported from the web `ActivityCenter`. A root-stack sibling of `(tabs)`,
 * pushed full-screen over the tabs from the feed-header bell (its non-tab home;
 * five tabs is the iOS max — the E4 nav decision).
 *
 * Three states drive each row's look, matching the model (see notifications.md):
 *   - unread    → bold, with an accent dot; what the bell badge counts.
 *   - seen      → normal weight, but still stands out until dealt with. Opening
 *                 this screen marks everything currently-unread *seen*, so the
 *                 badge clears while the items stay in the list.
 *   - addressed → dulled, but kept in the history. Tapping a row addresses it.
 *
 * Delivery is polling (push is the *additional* channel from Milestone D, not a
 * replacement). Tapping a row deep-links via `routeForNotification` — the *same*
 * map push taps use (`usePushTaps`), so in-app and push click-through agree.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api } from '@/api';
import { Avatar } from '@/components/Avatar';
import { routeForNotification } from '@/push';
import { colors, fontSize, spacing } from '@/theme';
import type { Notification } from '@/types';
import { formatRelativeTime } from '@/utils';

export default function ActivityScreen() {
  const queryClient = useQueryClient();
  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/'));

  const { data, isLoading } = useQuery({
    queryKey: ['notifications'],
    queryFn: api.getNotifications,
  });
  const notifications = data?.results ?? [];

  // Opening the screen marks everything currently-unread *seen* — the badge
  // clears, but every item stays in the list (that's the whole point). Fire it
  // once on mount, then refresh the badge + list so both reflect it. Any unread
  // that arrive *after* this stay unread until the next open, which is fine —
  // the web behaves the same (it marks seen on the open transition).
  useEffect(() => {
    let cancelled = false;
    api.markNotificationsSeen().then(() => {
      if (cancelled) return;
      queryClient.invalidateQueries({ queryKey: ['notificationsUnread'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    });
    return () => {
      cancelled = true;
    };
    // Mount-only: `markNotificationsSeen()` with no ids marks all unread seen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handlePress(notification: Notification) {
    // Click-through addresses it (the dulled, dealt-with state) and deep-links to
    // its target. We navigate immediately and let the refetch settle behind us —
    // a failed address shouldn't block navigation; the poll will reconcile.
    if (!notification.addressed) {
      api.markNotificationAddressed(notification.id).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ['notificationsUnread'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    }
    router.push(routeForNotification(notification.url));
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.topBar}>
        <Pressable
          onPress={goBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={8}
        >
          <Text style={styles.back}>← Back</Text>
        </Pressable>
        <Text style={styles.title}>Activity</Text>
        <View style={styles.spacer} />
      </View>

      {isLoading ? (
        <View style={styles.centre}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : (
        <FlatList
          data={notifications}
          keyExtractor={(n) => String(n.id)}
          renderItem={({ item }) => (
            <NotificationRow notification={item} onPress={handlePress} />
          )}
          ListEmptyComponent={
            <View style={styles.centre}>
              <Text style={styles.emptyTitle}>You&rsquo;re all caught up</Text>
              <Text style={styles.emptyBody}>
                Replies, reactions, connection requests, invites and event
                updates will show up here.
              </Text>
            </View>
          }
          contentContainerStyle={
            notifications.length === 0 ? styles.emptyContainer : undefined
          }
        />
      )}
    </SafeAreaView>
  );
}

// One row. Visual weight encodes the state: unread is bold with an accent dot;
// seen is normal weight; addressed is dulled (but still present).
function NotificationRow({
  notification,
  onPress,
}: {
  notification: Notification;
  onPress: (n: Notification) => void;
}) {
  const { actor, text, created_at, seen, addressed } = notification;
  return (
    <Pressable
      onPress={() => onPress(notification)}
      accessibilityRole="button"
      style={[styles.row, addressed && styles.rowDulled]}
    >
      <Avatar user={actor} size="sm" />
      <View style={styles.rowBody}>
        <Text style={[styles.rowText, !seen && styles.rowTextUnread]}>{text}</Text>
        <Text style={styles.rowTime}>{formatRelativeTime(created_at)}</Text>
      </View>
      {!seen && <View style={styles.dot} accessibilityElementsHidden />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  back: { fontSize: fontSize.sm, color: colors.inkFaint, fontWeight: '600' },
  title: {
    flex: 1,
    textAlign: 'center',
    fontSize: fontSize.base,
    fontWeight: '700',
    color: colors.ink,
  },
  spacer: { width: 48 },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.sm,
  },
  emptyContainer: { flexGrow: 1 },
  emptyTitle: { fontSize: fontSize.base, fontWeight: '600', color: colors.ink },
  emptyBody: {
    fontSize: fontSize.sm,
    color: colors.inkSoft,
    textAlign: 'center',
    lineHeight: 20,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  rowDulled: { opacity: 0.6 },
  rowBody: { flex: 1 },
  rowText: { fontSize: fontSize.sm, color: colors.ink, lineHeight: 19 },
  rowTextUnread: { fontWeight: '700' },
  rowTime: { marginTop: 2, fontSize: fontSize.sm, color: colors.inkFaint },
  dot: {
    marginTop: 6,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
});
