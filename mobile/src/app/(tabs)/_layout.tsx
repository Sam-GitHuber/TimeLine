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
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { api } from '@/api';
import { FeedIcon, PeopleIcon } from '@/components/icons';
import { colors } from '@/theme';

// The bar's content height *above* the home-indicator inset. The stock iOS tab
// bar is ~49pt here, which reads chunky under our lighter chrome; 40 trims it
// without crowding the smaller icon + label. The safe-area inset is added on
// top so the row still clears the home indicator (and collapses to nothing on
// devices without one).
const TAB_BAR_CONTENT_HEIGHT = 40;
const TAB_ICON_SIZE = 22;

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
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
        tabBarStyle: {
          backgroundColor: colors.raised,
          borderTopColor: colors.line,
          height: TAB_BAR_CONTENT_HEIGHT + insets.bottom,
          // Reserve *only* the safe-area inset at the bottom; with no matching
          // top padding, react-navigation centres the icon + label within the
          // remaining content height on its own. (Adding paddingTop or an icon
          // margin here reintroduces the top/bottom imbalance this had.)
          paddingBottom: insets.bottom,
        },
        tabBarLabelStyle: { fontSize: 10, fontWeight: '600' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Feed',
          tabBarIcon: ({ color }) => (
            <FeedIcon color={color as string} size={TAB_ICON_SIZE} />
          ),
        }}
      />
      <Tabs.Screen
        name="people"
        options={{
          title: 'People',
          tabBarIcon: ({ color }) => (
            <PeopleIcon color={color as string} size={TAB_ICON_SIZE} />
          ),
          // `undefined` (not 0) hides the badge — a 0 would render an empty pip.
          // Cap at 99+ so a large count can't blow out the pill.
          tabBarBadge: pending > 99 ? '99+' : pending > 0 ? pending : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.accent },
        }}
      />
    </Tabs>
  );
}
