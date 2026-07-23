/**
 * The activity-centre bell (Phase 9 E4c) — a header button on the feed tab that
 * opens the notification list (`/activity`) and carries an unread badge.
 *
 * It's a header button rather than a sixth tab because five tabs is the iOS
 * comfortable max and they're already full (the E4 nav decision) — so the bell
 * lives in the feed header, the Instagram pattern, alongside the profile bead.
 *
 * The badge polls the cheap unread-count endpoint on the slow cadence
 * (`NOTIFICATIONS_POLL_MS`), sharing the `['notificationsUnread']` query key with
 * the activity screen so marking things seen there clears the badge here at once.
 * Polling pauses when the app is backgrounded (the `focusManager`↔`AppState`
 * wiring in `_layout.tsx`), like every other poll in the app.
 */

import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { api, NOTIFICATIONS_POLL_MS } from '@/api';
import { colors } from '@/theme';

import { BellIcon } from './icons';

export function ActivityBell() {
  const { data } = useQuery({
    queryKey: ['notificationsUnread'],
    queryFn: api.getUnreadNotificationCount,
    refetchInterval: NOTIFICATIONS_POLL_MS,
  });
  const unread = data?.count ?? 0;

  return (
    <Pressable
      onPress={() => router.push('/activity')}
      accessibilityRole="button"
      accessibilityLabel={unread > 0 ? `Activity, ${unread} unread` : 'Activity'}
      hitSlop={8}
    >
      <BellIcon color={colors.ink} size={24} />
      {unread > 0 && (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{unread > 99 ? '99+' : unread}</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Anchored to the bell's top-right, like a native tab badge. `minWidth` keeps
  // a single digit circular while letting "99+" grow into a pill.
  badge: {
    position: 'absolute',
    top: -6,
    right: -8,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: colors.raised,
    fontSize: 11,
    fontWeight: '700',
  },
});
