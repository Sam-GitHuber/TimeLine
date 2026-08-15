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
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api, ApiError, serverMessage, WENT_WRONG } from '@/api';
import { useAuth } from '@/auth';
import { useActionMenu } from '@/components/ActionMenu';
import { useGroupActions } from '@/components/useGroupActions';
import { Avatar } from '@/components/Avatar';
import { ComposeBox } from '@/components/ComposeBox';
import { EventCard } from '@/components/events/EventCard';
import { MonthGrid } from '@/components/events/MonthGrid';
import { TimelineList } from '@/components/TimelineList';
import { eventLocalStart } from '@/eventFormat';
import { toGroupRows } from '@/feed';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { Post } from '@/types';
import { useDayBoundary } from '@/useDayBoundary';

// A render error on this screen stops here instead of blanking the whole app
// (#299). expo-router wraps a route in its `ErrorBoundary` export, and installs
// nothing by default — see `components/ErrorBoundary` for what that means.
export { ErrorBoundary } from '@/components/ErrorBoundary';

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

  /**
   * **An empty group and an unanswered one are different things** (#317).
   *
   * Four queries hang off this page, and none of them had an error branch: the
   * fetch fails, `data` is undefined, the `?? []` below turns that into an empty
   * array, and an empty state written as a flat statement of fact renders. "No
   * posts here yet — say something to the group" on a group with two years of
   * shared history reads as a brand-new one, and the natural response to that
   * sentence is to post into it again. Losing signal does it, and so does
   * catching the box mid-restart, which is what publishing a GitHub Release does
   * (`deploy.md`).
   *
   * `&& !data` in every one of them, never a bare `isError` — a failed *refresh*
   * keeps the posts, events and calendar it already has, and those stay on
   * screen rather than being replaced by an apology (#309/#311, and the same
   * rule the group header above follows).
   */
  const postsLoadFailed = postsQuery.isError && !postsQuery.data;
  const calendarLoadFailed = calendarQuery.isError && !calendarQuery.data;
  const upcomingLoadFailed = upcomingQuery.isError && !upcomingQuery.data;
  const pastEventsLoadFailed = pastEventsQuery.isError && !pastEventsQuery.data;

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
  // Ordered by each event's own wall-clock start, the same value the timeline
  // below groups past events by — see `eventLocalStart`. (Non-null: the filter
  // above keeps only dated events.)
  const scheduledFuture = upcoming
    .filter((e) => e.event_date)
    .sort(
      (a, b) => eventLocalStart(b)!.getTime() - eventLocalStart(a)!.getTime()
    );
  const upcomingCount = upcoming.length;

  const goBack = () =>
    router.canGoBack() ? router.back() : router.replace('/groups');

  const { leave, remove } = useGroupActions(id);

  const { openMenu, menu } = useActionMenu();

  function showMenu() {
    // "Plan an event" leads — any active member can plan (events.md), and it's
    // the group page's main creative action.
    //
    // Seven items for an admin. That is *fine* through `useActionMenu` and was
    // catastrophic through the old `Alert` fallback, which silently kept only
    // the first three — see the note in ActionMenu.tsx.
    openMenu({
      title: group?.name ?? 'Group',
      items: [
        { label: 'Plan an event', onPress: () => router.push(`/groups/${id}/plan`) },
        { label: 'Invite people', onPress: () => router.push(`/groups/${id}/invite`) },
        { label: 'Members', onPress: () => router.push(`/groups/${id}/members`) },
        ...(isAdmin
          ? [
              { label: 'Edit group', onPress: () => router.push(`/groups/${id}/edit`) },
              { label: 'Delete group', destructive: true, onPress: remove },
            ]
          : []),
        { label: 'Leave group', destructive: !isAdmin, onPress: leave },
      ],
    });
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

  // Where the missing future gets said. The region below only renders when
  // there *are* upcoming events, so without this a failed fetch leaves the space
  // above the composer silent — and nothing on screen distinguishes "nothing is
  // planned" from "we couldn't ask".
  const upcomingFailure = upcomingLoadFailed ? (
    <View style={styles.upcoming}>
      <Text style={styles.inlineError}>
        {serverMessage(upcomingQuery.error, 'Couldn’t load what’s coming up.')}
      </Text>
      {/* Named, not a bare "Try again": more than one of these can be on screen
          at once — one outage takes down the upcoming fetch and the posts
          together — and to a screen reader they'd otherwise be the same
          control twice, with the sentence explaining each in a separate
          element. */}
      <Pressable
        onPress={() => upcomingQuery.refetch()}
        accessibilityRole="button"
        accessibilityLabel="Try loading the upcoming events again"
        style={({ pressed }) => [styles.retry, styles.retryInline, pressed && styles.pressed]}
      >
        <Text style={styles.retryText}>Try again</Text>
      </Pressable>
    </View>
  ) : null;

  // The upcoming region — furthest-first, so the nearest event sits just above
  // the composer's "now". Date-less "being planned" events follow in a staging
  // strip. Rendered above the composer in the timeline view's header.
  const upcomingSection =
    upcomingCount > 0 ? (
      <View style={styles.upcoming}>
        <Text style={styles.upcomingHeading}>
          ↑ {upcomingCount} upcoming
        </Text>
        {/* `showActions` — the reaction row and comment count, as a post on
            the timeline below carries. This region *is* the phone's version of
            the web's upcoming timeline entries, so it gets a timeline entry's
            affordances; the calendar tab's cards don't (see `EventCard`). */}
        {scheduledFuture.map((e) => (
          <EventCard key={e.id} event={e} showActions />
        ))}
        {staging.length > 0 ? (
          <>
            <Text style={styles.stagingHeading}>Being planned</Text>
            {staging.map((e) => (
              <EventCard key={e.id} event={e} showActions />
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
          <Pressable onPress={showMenu} accessibilityRole="button" accessibilityLabel="Group actions" hitSlop={8}>
            <Text style={styles.menu}>⋯</Text>
          </Pressable>
        ) : (
          <View style={styles.menuSpacer} />
        )}
      </View>

      {/* **The group we have beats an error about refreshing it** — the same
          rule `CommentThread` and the post screen follow. A failed refetch keeps
          its data and only flips `status` to 'error', and `staleTime` is 0 with
          every foreground refetching this key, so reading `isError` before the
          data threw away a loaded timeline, its events and the calendar the
          moment the app came back on patchy signal. A 404 still wins over the
          cached copy: private-now or left-now is a real answer about *now*. */}
      {notFound ? (
        <View style={styles.centre}>
          <Text style={styles.emptyTitle}>This group isn’t available.</Text>
          <Text style={styles.emptyBody}>
            It may be private, or you may have left it.
          </Text>
        </View>
      ) : !group ? (
        groupQuery.isError ? (
          <View style={styles.centre}>
            <Text style={styles.emptyTitle}>Couldn’t load this group</Text>
            <Pressable style={styles.retry} onPress={() => groupQuery.refetch()}>
              <Text style={styles.retryText}>Try again</Text>
            </Pressable>
          </View>
        ) : (
          <ActivityIndicator color={colors.accent} style={styles.spinner} />
        )
      ) : view === 'calendar' ? (
        <ScrollView contentContainerStyle={styles.calendarContent}>
          {identity}
          {toggle}
          {calendarLoadFailed ? (
            // Not "no dated events yet", and not an empty grid either: a drawn
            // month with nothing in it is the most confident possible lie about
            // a calendar, told to someone with a wedding in this group on
            // Saturday.
            // `locked`, not `centre`: this sits inside a ScrollView whose
            // content container isn't `flexGrow`, where a `flex: 1` child
            // collapses to nothing.
            <View style={styles.locked}>
              <Text style={styles.emptyTitle}>Couldn’t load the calendar</Text>
              <Text style={styles.emptyBody}>
                {serverMessage(calendarQuery.error, WENT_WRONG)}
              </Text>
              <Pressable
                onPress={() => calendarQuery.refetch()}
                accessibilityRole="button"
                accessibilityLabel="Try loading the calendar again"
                style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
              >
                <Text style={styles.retryText}>Try again</Text>
              </Pressable>
            </View>
          ) : calendarQuery.isLoading ? (
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
              {upcomingFailure}
              {upcomingSection}
              <ComposeBox user={me} groupId={id} />
            </>
          }
          onEndReached={() => {
            if (postsQuery.hasNextPage && !postsQuery.isFetchingNextPage) {
              postsQuery.fetchNextPage();
            }
          }}
          ListEmptyComponent={
            postsLoadFailed ? (
              // The loudest one in this family. Said to someone whose group has
              // two years of history behind it, the empty state below invites
              // them to post it all again.
              <View style={styles.locked}>
                <Text style={styles.emptyTitle}>Couldn’t load these posts</Text>
                <Text style={styles.emptyBody}>
                  {serverMessage(postsQuery.error, WENT_WRONG)}
                </Text>
                <Pressable
                  onPress={() => postsQuery.refetch()}
                  accessibilityRole="button"
                  accessibilityLabel="Try loading the posts again"
                  style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
                >
                  <Text style={styles.retryText}>Try again</Text>
                </Pressable>
              </View>
            ) : postsQuery.isLoading ? (
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
            ) : (
              <>
                {/* The partial cases, `EventPhotos`' shape: a timeline that
                    stopped short looks exactly like one that ended, and a
                    missing recap leaves no hole behind it. Both are a line under
                    content that did load, not a state replacing it.
                    Keyed off `rows`, not off `postsQuery.data`, because the
                    recaps land on this same spine from a *different* query — so
                    a cold posts failure beside events that loaded fine leaves a
                    non-empty list, and the state in `ListEmptyComponent` never
                    gets its turn. That case says the whole timeline is missing,
                    not merely its tail. */}
                {postsQuery.isError && rows.length > 0 ? (
                  <View style={styles.footerNote}>
                    <Text style={styles.inlineError}>
                      {postsLoadFailed
                        ? 'Couldn’t load this group’s posts.'
                        : 'Couldn’t load any older posts.'}
                    </Text>
                    {/* The cold case gets a way out, because it has none
                        otherwise: the card that owns the Try again lives in
                        `ListEmptyComponent`, which a list full of recaps never
                        renders, and this screen passes no `refreshControl`.
                        The *older posts* case doesn't need one — scrolling on
                        re-arms `onEndReached`. */}
                    {postsLoadFailed ? (
                      <Pressable
                        onPress={() => postsQuery.refetch()}
                        accessibilityRole="button"
                        accessibilityLabel="Try loading the posts again"
                        style={({ pressed }) => [
                          styles.retry,
                          styles.retryInline,
                          pressed && styles.pressed,
                        ]}
                      >
                        <Text style={styles.retryText}>Try again</Text>
                      </Pressable>
                    ) : null}
                  </View>
                ) : null}
                {pastEventsLoadFailed ? (
                  <View style={styles.footerNote}>
                    <Text style={styles.inlineError}>
                      {serverMessage(
                        pastEventsQuery.error,
                        'Couldn’t load this group’s past events.'
                      )}
                    </Text>
                    <Pressable
                      onPress={() => pastEventsQuery.refetch()}
                      accessibilityRole="button"
                      accessibilityLabel="Try loading the past events again"
                      style={({ pressed }) => [
                        styles.retry,
                        styles.retryInline,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Text style={styles.retryText}>Try again</Text>
                    </Pressable>
                  </View>
                ) : null}
              </>
            )
          }
        />
      )}

      {menu}
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
  // A retry that sits under a single line rather than in a centred card.
  retryInline: { alignSelf: 'center', marginTop: spacing.xs },
  pressed: { opacity: 0.7 },
  // The quieter form: a line beside content that did load, saying what didn't.
  inlineError: {
    fontSize: fontSize.sm,
    color: colors.danger,
    textAlign: 'center',
    lineHeight: 20,
  },
  footerNote: { paddingHorizontal: spacing.md, marginTop: spacing.md },
  footer: { marginVertical: spacing.lg },
});
