/**
 * A group's page (Phase 9 E3a) — its shared timeline, and where you post into it.
 *
 * Structurally the feed, scoped to one group: the connection-pruned group
 * timeline (`getGroupPosts`, rendered through the shared `TimelineList`) with a
 * group-scoped `ComposeBox` capping it. Non-members can't reach here — the detail
 * 404s (a private group's existence isn't leaked), handled as "not available".
 *
 * The **⋯ menu** carries the group actions: Invite, Members, Leave, and — for
 * admins — Edit and Delete. Members + Invite are their own pushed screens
 * (E3a); Leave/Delete confirm first.
 *
 * **Events (E3b)** hang off this page two ways. Upcoming events sit in a section
 * *above* the composer (post-shaped cards, nearest just above the "now" of the
 * compose box — scroll up to travel forward); past events fall **into** the
 * timeline among the posts as recaps (`toGroupRows`). A **Timeline / Calendar**
 * toggle swaps the spine for a month grid. Planning an event (the organiser's
 * create) is E3c. See events.md.
 *
 * Whose posts you see here is **connection-gated**, not membership-gated (see
 * groups.md): you see a co-member's posts only if you're connected. So each
 * member sees a partial timeline — "my connections' posts under a shared label".
 */

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api, ApiError } from '@/api';
import { useAuth } from '@/auth';
import { useGroupActions } from '@/components/useGroupActions';
import { Avatar } from '@/components/Avatar';
import { ComposeBox } from '@/components/ComposeBox';
import { EventCard } from '@/components/events/EventCard';
import { MonthGrid } from '@/components/events/MonthGrid';
import { TimelineList } from '@/components/TimelineList';
import { toGroupRows } from '@/feed';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { Post } from '@/types';
import { useDayBoundary } from '@/useDayBoundary';

export default function GroupScreen() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const id = Number(groupId);
  const { user: me } = useAuth();

  // Timeline (the spine) or Calendar (the month grid) — a per-group view toggle.
  const [view, setView] = useState<'timeline' | 'calendar'>('timeline');

  const groupQuery = useQuery({
    queryKey: ['group', id],
    queryFn: () => api.getGroup(id),
  });
  const group = groupQuery.data;
  const isAdmin = group?.your_role === 'admin';

  const postsQuery = useInfiniteQuery({
    queryKey: ['groupPosts', id],
    queryFn: ({ pageParam }) =>
      pageParam ? api.getPage<Post>(pageParam) : api.getGroupPosts(id),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
    enabled: !!group,
  });

  // Upcoming events hang above the composer; past events fall into the spine.
  // Both are plain (bounded) arrays, not paginated.
  const upcomingQuery = useQuery({
    queryKey: ['groupEvents', id, 'upcoming'],
    queryFn: () => api.getGroupEvents(id, 'upcoming'),
    enabled: !!group,
  });
  const pastEventsQuery = useQuery({
    queryKey: ['groupEvents', id, 'past'],
    queryFn: () => api.getGroupEvents(id, 'past'),
    enabled: !!group,
  });
  const calendarQuery = useQuery({
    queryKey: ['groupCalendar', id],
    queryFn: () => api.getGroupCalendar(id),
    enabled: !!group && view === 'calendar',
  });

  const today = useDayBoundary();
  const rows = useMemo(
    () =>
      toGroupRows(
        postsQuery.data?.pages.flatMap((p) => p.results) ?? [],
        pastEventsQuery.data ?? []
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- today is a trigger
    [postsQuery.data, pastEventsQuery.data, today]
  );

  // Cancelled events are tombstones, not upcoming plans — leave them off the
  // upcoming region (they resurface as a past recap once their date passes, and
  // the detail page keeps them). Scheduled events are ordered **furthest-first**
  // so the nearest one ends up just above the composer's "now"; date-less events
  // being planned sit in a small staging strip after them.
  const upcoming = (upcomingQuery.data ?? []).filter((e) => e.status !== 'cancelled');
  const staging = upcoming.filter((e) => !e.event_date);
  const scheduledFuture = upcoming
    .filter((e) => e.event_date)
    .sort(
      (a, b) =>
        new Date(b.starts_at ?? b.event_date!).getTime() -
        new Date(a.starts_at ?? a.event_date!).getTime()
    );
  const upcomingCount = upcoming.length;

  const goBack = () =>
    router.canGoBack() ? router.back() : router.replace('/groups');

  const { leave, remove } = useGroupActions(id);

  function openMenu() {
    const options = ['Invite people', 'Members'];
    const adminOptions = isAdmin ? ['Edit group', 'Delete group'] : [];
    const labels = [...options, ...adminOptions, 'Leave group', 'Cancel'];
    const cancelIndex = labels.length - 1;
    const leaveIndex = cancelIndex - 1;
    const deleteIndex = isAdmin ? labels.indexOf('Delete group') : -1;

    const run = (i: number) => {
      const label = labels[i];
      if (label === 'Invite people') router.push(`/groups/${id}/invite`);
      else if (label === 'Members') router.push(`/groups/${id}/members`);
      else if (label === 'Edit group') router.push(`/groups/${id}/edit`);
      else if (label === 'Delete group') remove();
      else if (label === 'Leave group') leave();
    };

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: labels,
          destructiveButtonIndex: deleteIndex >= 0 ? deleteIndex : leaveIndex,
          cancelButtonIndex: cancelIndex,
        },
        run
      );
    } else {
      // Android fallback (Phase 10 refines this): a simple alert chooser.
      Alert.alert(group?.name ?? 'Group', undefined, [
        ...labels.slice(0, cancelIndex).map((label, i) => ({
          text: label,
          onPress: () => run(i),
          style: (label === 'Delete group' || label === 'Leave group'
            ? 'destructive'
            : 'default') as 'destructive' | 'default',
        })),
        { text: 'Cancel', style: 'cancel' as const },
      ]);
    }
  }

  const notFound =
    groupQuery.error instanceof ApiError && groupQuery.error.status === 404;

  const identity = group ? (
    <View style={styles.info}>
      <Avatar user={{ display_name: group.name, avatar_thumb: group.avatar_thumb }} size="lg" />
      <View style={styles.infoBody}>
        {group.description ? (
          <Text style={styles.description}>{group.description}</Text>
        ) : null}
        <Pressable
          onPress={() => router.push(`/groups/${id}/members`)}
          accessibilityRole="button"
          hitSlop={6}
        >
          <Text style={styles.memberCount}>
            {group.member_count} {group.member_count === 1 ? 'member' : 'members'} ›
          </Text>
        </Pressable>
      </View>
    </View>
  ) : null;

  const toggle = (
    <View style={styles.toggle} accessibilityLabel="Group view">
      <Pressable
        onPress={() => setView('timeline')}
        accessibilityRole="button"
        accessibilityState={{ selected: view === 'timeline' }}
        style={[styles.toggleBtn, view === 'timeline' && styles.toggleOn]}
      >
        <Text style={[styles.toggleText, view === 'timeline' && styles.toggleTextOn]}>
          Timeline
        </Text>
      </Pressable>
      <Pressable
        onPress={() => setView('calendar')}
        accessibilityRole="button"
        accessibilityState={{ selected: view === 'calendar' }}
        style={[styles.toggleBtn, view === 'calendar' && styles.toggleOn]}
      >
        <Text style={[styles.toggleText, view === 'calendar' && styles.toggleTextOn]}>
          Calendar
        </Text>
      </Pressable>
    </View>
  );

  // The upcoming region — furthest-first, so the nearest event sits just above
  // the composer's "now". Date-less "being planned" events follow in a staging
  // strip. Rendered above the composer in the timeline view's header.
  const upcomingSection =
    upcomingCount > 0 ? (
      <View style={styles.upcoming}>
        <Text style={styles.upcomingHeading}>
          ↑ {upcomingCount} upcoming
        </Text>
        {scheduledFuture.map((e) => (
          <EventCard key={e.id} event={e} />
        ))}
        {staging.length > 0 ? (
          <>
            <Text style={styles.stagingHeading}>Being planned</Text>
            {staging.map((e) => (
              <EventCard key={e.id} event={e} />
            ))}
          </>
        ) : null}
      </View>
    ) : null;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.topBar}>
        <Pressable onPress={goBack} accessibilityRole="button" accessibilityLabel="Back" hitSlop={8}>
          <Text style={styles.back}>← Back</Text>
        </Pressable>
        <Text style={styles.topName} numberOfLines={1}>
          {group?.name ?? 'Group'}
        </Text>
        {group ? (
          <Pressable onPress={openMenu} accessibilityRole="button" accessibilityLabel="Group actions" hitSlop={8}>
            <Text style={styles.menu}>⋯</Text>
          </Pressable>
        ) : (
          <View style={styles.menuSpacer} />
        )}
      </View>

      {groupQuery.isLoading ? (
        <ActivityIndicator color={colors.accent} style={styles.spinner} />
      ) : notFound ? (
        <View style={styles.centre}>
          <Text style={styles.emptyTitle}>This group isn’t available.</Text>
          <Text style={styles.emptyBody}>
            It may be private, or you may have left it.
          </Text>
        </View>
      ) : groupQuery.isError ? (
        <View style={styles.centre}>
          <Text style={styles.emptyTitle}>Couldn’t load this group</Text>
          <Pressable style={styles.retry} onPress={() => groupQuery.refetch()}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : view === 'calendar' ? (
        <ScrollView contentContainerStyle={styles.calendarContent}>
          {identity}
          {toggle}
          {calendarQuery.isLoading ? (
            <ActivityIndicator color={colors.accent} style={styles.spinner} />
          ) : (calendarQuery.data ?? []).length === 0 ? (
            <Text style={styles.calendarEmpty}>
              No dated events yet. Scheduled events show up here.
            </Text>
          ) : (
            <MonthGrid events={calendarQuery.data ?? []} />
          )}
        </ScrollView>
      ) : (
        <TimelineList
          rows={rows}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={
            <>
              {identity}
              {toggle}
              {upcomingSection}
              <ComposeBox
                user={me}
                groupId={id}
                invalidateKey={['groupPosts', id]}
              />
            </>
          }
          onEndReached={() => {
            if (postsQuery.hasNextPage && !postsQuery.isFetchingNextPage) {
              postsQuery.fetchNextPage();
            }
          }}
          ListEmptyComponent={
            postsQuery.isLoading ? (
              <ActivityIndicator color={colors.accent} style={styles.spinner} />
            ) : (
              <View style={styles.locked}>
                <Text style={styles.emptyBody}>
                  No posts here yet — say something to the group.
                </Text>
              </View>
            )
          }
          ListFooterComponent={
            postsQuery.isFetchingNextPage ? (
              <ActivityIndicator style={styles.footer} color={colors.accent} />
            ) : null
          }
        />
      )}
    </SafeAreaView>
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
  topName: { flex: 1, textAlign: 'center', fontSize: fontSize.base, fontWeight: '700', color: colors.ink },
  menu: { fontSize: 22, color: colors.ink, fontWeight: '700', width: 44, textAlign: 'right' },
  menuSpacer: { width: 44 },
  info: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  infoBody: { flex: 1, gap: spacing.xs },
  description: { fontSize: fontSize.base, color: colors.inkSoft, lineHeight: 22 },
  memberCount: { fontSize: fontSize.sm, color: colors.accent, fontWeight: '600' },
  toggle: {
    flexDirection: 'row',
    alignSelf: 'center',
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  toggleBtn: { paddingHorizontal: spacing.lg, paddingVertical: spacing.xs },
  toggleOn: { backgroundColor: colors.accent },
  toggleText: { fontSize: fontSize.sm, fontWeight: '600', color: colors.inkSoft },
  toggleTextOn: { color: colors.raised },
  upcoming: { paddingHorizontal: spacing.md, gap: spacing.sm, marginBottom: spacing.sm },
  upcomingHeading: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.accentDeep,
    textAlign: 'center',
  },
  stagingHeading: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.inkFaint,
    textTransform: 'uppercase',
    marginTop: spacing.xs,
  },
  calendarContent: { padding: spacing.md, paddingBottom: spacing.xxl },
  calendarEmpty: {
    fontSize: fontSize.sm,
    color: colors.inkSoft,
    textAlign: 'center',
    marginTop: spacing.xl,
  },
  spinner: { marginTop: spacing.xl },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.sm },
  locked: { padding: spacing.xl, alignItems: 'center', gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.base, fontWeight: '600', color: colors.ink, textAlign: 'center' },
  emptyBody: { fontSize: fontSize.sm, color: colors.inkSoft, textAlign: 'center', lineHeight: 20 },
  retry: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  retryText: { color: colors.ink, fontWeight: '600' },
  footer: { marginVertical: spacing.lg },
});
