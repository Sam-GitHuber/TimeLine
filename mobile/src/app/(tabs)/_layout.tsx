/**
 * The app's primary navigation: a native bottom tab bar.
 *
 * Introduced in Milestone E (the E1 nav decision) so the parity surfaces —
 * People here, then Messages / Groups / Activity / Settings as E2–E4 land — each
 * become a tab rather than accreting buttons on the feed header. Post detail and
 * profiles deliberately live *outside* this group (root-stack siblings), so
 * opening one covers the tab bar full-screen, the expected native behaviour.
 *
 * The People tab carries a badge of your pending connection-request count. It
 * reads the same `['connectionRequests']` query the Requests segment and the
 * ConnectButton invalidate, so approving/rejecting anywhere updates the badge.
 */

import { useQuery } from '@tanstack/react-query';
import { Tabs } from 'expo-router';

import { api } from '@/api';
import { FeedIcon, PeopleIcon } from '@/components/icons';
import { colors } from '@/theme';

export default function TabsLayout() {
  const { data } = useQuery({
    queryKey: ['connectionRequests'],
    queryFn: api.getConnectionRequests,
  });
  const pending = data?.count ?? 0;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.inkFaint,
        tabBarStyle: { backgroundColor: colors.raised, borderTopColor: colors.line },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Feed',
          tabBarIcon: ({ color }) => <FeedIcon color={color as string} />,
        }}
      />
      <Tabs.Screen
        name="people"
        options={{
          title: 'People',
          tabBarIcon: ({ color }) => <PeopleIcon color={color as string} />,
          // `undefined` (not 0) hides the badge — a 0 would render an empty pip.
          tabBarBadge: pending > 0 ? pending : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.accent },
        }}
      />
    </Tabs>
  );
}
