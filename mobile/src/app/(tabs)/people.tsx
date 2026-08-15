/**
 * The People hub — your side of the connection graph. Ported from the web's
 * `PeoplePage.jsx`; three segments share the screen:
 *
 *   • Connections — people you're already connected with (the default: the
 *     everyday job is reaching a friend's profile in one tap, so it must not sit
 *     behind a pile of requests).
 *   • Discover    — everyone else, each with a Connect control.
 *   • Requests    — people asking to connect, to approve or reject.
 *
 * The active segment is local state, not a route param: unlike the web (where
 * `?tab=` makes it linkable and back-navigable), nothing deep-links into a
 * specific segment on mobile, and a tab screen re-mounting from the bottom bar
 * should just open on Connections. Revisit if a notification ever needs to land
 * on Requests directly — the deep-link map (notifications.md) currently sends
 * connection requests to People, and opening on Connections there is fine.
 */

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { router } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api, serverMessage, WENT_WRONG } from '@/api';
import { Avatar } from '@/components/Avatar';
import { ConnectButton } from '@/components/ConnectButton';
import { invalidateConnectionChange } from '@/connectionCache';
import { dedupeById, trimToFirstPage } from '@/lists';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { ConnectionRequest, Paginated, PersonSummary } from '@/types';

// A render error on this screen stops here instead of blanking the whole app
// (#299). expo-router wraps a route in its `ErrorBoundary` export, and installs
// nothing by default — see `components/ErrorBoundary` for what that means.
export { ErrorBoundary } from '@/components/ErrorBoundary';

type Segment = 'connections' | 'discover' | 'requests';

/**
 * Pull-to-refresh for an infinite list: drop back to the first page, then
 * refetch it. Trimming first means a pull re-fetches only page one — where
 * anything new lands — rather than every page loaded so far, the same guard the
 * feed uses (`trimToFirstPage`).
 *
 * `refreshing` is tracked here rather than read off `isRefetching` so the
 * spinner belongs to the user's own pull, not to a background refetch (e.g. the
 * one a connect/approve invalidation triggers).
 */
function usePullToRefresh(
  queryKey: readonly unknown[],
  refetch: () => Promise<unknown>
) {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      queryClient.setQueryData<InfiniteData<Paginated<unknown>, string>>(
        queryKey,
        trimToFirstPage
      );
      await refetch();
    } finally {
      setRefreshing(false);
    }
  }, [queryClient, queryKey, refetch]);
  return { refreshing, onRefresh };
}

export default function PeopleScreen() {
  const [segment, setSegment] = useState<Segment>('connections');

  // Shared with the tab badge (same query key), so the count stays in step
  // wherever a request is approved or rejected.
  const { data: requestsData } = useQuery({
    queryKey: ['connectionRequests'],
    queryFn: api.getConnectionRequests,
  });
  const pendingCount = requestsData?.count ?? 0;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>People</Text>
        <View
          style={styles.segments}
          accessibilityRole="tablist"
          accessibilityLabel="People"
        >
          <SegmentTab
            label="Connections"
            active={segment === 'connections'}
            onPress={() => setSegment('connections')}
          />
          <SegmentTab
            label="Discover"
            active={segment === 'discover'}
            onPress={() => setSegment('discover')}
          />
          <SegmentTab
            label="Requests"
            active={segment === 'requests'}
            badge={pendingCount}
            onPress={() => setSegment('requests')}
          />
        </View>
      </View>

      {segment === 'requests' ? (
        <RequestsList />
      ) : segment === 'discover' ? (
        <DiscoverList />
      ) : (
        <ConnectionsList onFindPeople={() => setSegment('discover')} />
      )}
    </SafeAreaView>
  );
}

function SegmentTab({
  label,
  active,
  badge = 0,
  onPress,
}: {
  label: string;
  active: boolean;
  badge?: number;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      style={[styles.segment, active && styles.segmentActive]}
    >
      <Text style={[styles.segmentLabel, active && styles.segmentLabelActive]}>
        {label}
      </Text>
      {badge > 0 && (
        <View style={[styles.badge, active && styles.badgeActive]}>
          <Text style={[styles.badgeText, active && styles.badgeTextActive]}>
            {badge > 99 ? '99+' : badge}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

/**
 * A person's row: avatar + name (both open the profile), with a `trailing`
 * control on the right — a chevron on Connections, a Connect button on Discover,
 * Approve/Reject on Requests.
 */
function PersonRow({
  person,
  trailing,
}: {
  person: { id: number; display_name: string; avatar_thumb: string | null };
  trailing: React.ReactNode;
}) {
  return (
    <View style={styles.row}>
      <Pressable
        onPress={() => router.push(`/u/${person.id}`)}
        accessibilityRole="button"
        accessibilityLabel={`${person.display_name}'s profile`}
        style={styles.rowMain}
        hitSlop={4}
      >
        <Avatar user={person} size="md" />
        <Text style={styles.rowName} numberOfLines={1}>
          {person.display_name}
        </Text>
      </Pressable>
      {trailing}
    </View>
  );
}

/** A centred message for the loading / empty states the lists share. */
function ListMessage({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.message}>
      <Text style={styles.messageText}>{children}</Text>
    </View>
  );
}

/**
 * The error state, with a retry — so a transient network failure isn't a
 * dead-end (matches the feed and profile screens, which both offer "Try again").
 */
function ListError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <View style={styles.message}>
      <Text style={[styles.messageText, styles.messageError]}>{message}</Text>
      <Pressable
        onPress={onRetry}
        accessibilityRole="button"
        style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
      >
        <Text style={styles.retryText}>Try again</Text>
      </Pressable>
    </View>
  );
}

/**
 * Shared shell for the two directory lists (Connections, Discover). Both page a
 * `PersonSummary` list the same way — following the paginator's `next` — so the
 * infinite-query plumbing lives here once and each caller supplies only the row
 * trailing and its empty state.
 */
function DirectoryList({
  queryKey,
  initialFetch,
  renderTrailing,
  empty,
  loadingText,
  errorText,
}: {
  queryKey: readonly unknown[];
  initialFetch: () => Promise<Paginated<PersonSummary>>;
  renderTrailing: (person: PersonSummary) => React.ReactNode;
  empty: React.ReactNode;
  loadingText: string;
  errorText: string;
}) {
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) =>
      pageParam ? api.getPage<PersonSummary>(pageParam) : initialFetch(),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
  });
  const { refreshing, onRefresh } = usePullToRefresh(queryKey, query.refetch);

  const people = dedupeById(query.data?.pages.flatMap((page) => page.results) ?? []);
  const errorMessage = serverMessage(query.error, errorText);

  // The FlatList renders in every state (not just when populated) so pull-to-
  // refresh works from the empty and error states too — loading/error/empty go
  // through ListEmptyComponent, as the feed does.
  return (
    <FlatList
      data={people}
      keyExtractor={(person) => String(person.id)}
      renderItem={({ item }) => (
        <PersonRow person={item} trailing={renderTrailing(item)} />
      )}
      // `alwaysBounceVertical` + a full-height content container let the list
      // overscroll (and so pull-to-refresh) even when it's short or empty — a
      // FlatList that fits on screen otherwise can't bounce, so a sparse
      // Discover/Requests tab would silently swallow the pull gesture.
      alwaysBounceVertical
      contentContainerStyle={styles.listContent}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.accent}
        />
      }
      onEndReached={() => {
        if (query.hasNextPage && !query.isFetchingNextPage) query.fetchNextPage();
      }}
      onEndReachedThreshold={0.5}
      ListEmptyComponent={
        query.isLoading ? (
          <ListMessage>{loadingText}</ListMessage>
        ) : query.isError ? (
          <ListError message={errorMessage} onRetry={query.refetch} />
        ) : (
          <>{empty}</>
        )
      }
      ListFooterComponent={
        query.isFetchingNextPage ? (
          <ActivityIndicator style={styles.footer} color={colors.accent} />
        ) : null
      }
    />
  );
}

function ConnectionsList({ onFindPeople }: { onFindPeople: () => void }) {
  return (
    <DirectoryList
      queryKey={['connections']}
      initialFetch={api.listConnections}
      loadingText="Loading connections…"
      errorText="Couldn’t load your connections."
      renderTrailing={(person) => (
        <Pressable
          onPress={() => router.push(`/u/${person.id}`)}
          accessibilityRole="button"
          accessibilityLabel={`View ${person.display_name}'s profile`}
          hitSlop={8}
          style={styles.chevron}
        >
          <Text style={styles.chevronGlyph}>›</Text>
        </Pressable>
      )}
      empty={
        <View style={styles.emptyBlock}>
          <Text style={styles.messageText}>
            You’re not connected with anyone yet.
          </Text>
          <Pressable
            onPress={onFindPeople}
            accessibilityRole="button"
            style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
          >
            <Text style={styles.primaryBtnLabel}>Find people</Text>
          </Pressable>
        </View>
      }
    />
  );
}

function DiscoverList() {
  return (
    <DirectoryList
      // Keyed under ['users', …] so the ConnectButton's ['users'] invalidation
      // refreshes Discover too, flipping a row's button after you act.
      queryKey={['users', 'discover']}
      initialFetch={api.listDiscover}
      loadingText="Loading people…"
      errorText="Couldn’t load people."
      renderTrailing={(person) => (
        <ConnectButton
          userId={person.id}
          displayName={person.display_name}
          connectionStatus={person.connection_status}
        />
      )}
      empty={
        <ListMessage>You’re connected with everyone here already.</ListMessage>
      }
    />
  );
}

/**
 * The decision a row's two buttons make, carried as data rather than as the
 * `act` function the row used to hand in: the success handler has to be able to
 * tell approve from reject, since only one of them changes what the rest of the
 * app may show. `requesterId` rides along because the refresh is about that
 * person's profile and posts, not the request row's own id. (Same shape both
 * invite inboxes settled on for accept vs decline — groups.md.)
 */
type Decision = { approve: boolean; id: number; requesterId: number };

/**
 * Your inbox of incoming requests. Approve makes the connection mutual (you both
 * start seeing each other's posts); Reject discards it. Approving therefore
 * refreshes everything a connection gates (`connectionCache.ts`) — the feed, the
 * calendars, the group events — where rejecting keeps the narrow set: the inbox,
 * its badge, and the requester's own row.
 */
function RequestsList() {
  const queryClient = useQueryClient();

  const query = useInfiniteQuery({
    queryKey: ['connectionRequests', 'list'],
    queryFn: ({ pageParam }) =>
      pageParam
        ? api.getPage<ConnectionRequest>(pageParam)
        : api.getConnectionRequests(),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
  });
  const { refreshing, onRefresh } = usePullToRefresh(
    ['connectionRequests', 'list'],
    query.refetch
  );

  const decide = useMutation({
    mutationFn: ({ approve, id }: Decision) =>
      approve ? api.approveRequest(id) : api.rejectRequest(id),
    onSuccess: (_data, { approve, requesterId }) => {
      if (approve) {
        // Approving makes the connection real, which moves the whole visibility
        // boundary — not just this list. Same set as every other connection
        // write; see `connectionCache.ts`.
        invalidateConnectionChange(queryClient, requesterId);
        return;
      }
      // Rejecting deletes a still-pending row and connects nobody, so the gated
      // surfaces are correct as they stand — the narrow set is all it needs,
      // exactly as declining a group invite keeps its own (groups.md). This is
      // the one place the narrow case is safe to assume, because the *server*
      // guarantees it: `ConnectionRequestActionView` 404s unless the row is
      // still pending, so a reject that gets here can't have ended a
      // connection. What changes is the inbox, its badge, and their button —
      // back to "Connect" — on whichever people list is behind this one.
      queryClient.invalidateQueries({ queryKey: ['connectionRequests'] });
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: ['user', requesterId] });
    },
    /**
     * #239 — the write had no error path, and the screen's *query* error is not
     * a substitute for one. `onSuccess` is the only place an invalidation runs,
     * so a request the other person had since withdrawn answered 404 and the
     * row stayed exactly where it was: it reads as a broken button, and on the
     * approve path you walk away believing you're connected to someone you
     * aren't, wondering later why their posts never reach your feed.
     *
     * An `Alert` rather than an inline line, matching the two screens that had
     * this shape right already (the messages list's `rowAction`, the group
     * roster's): a row's failure has no room of its own in a `FlatList`, and a
     * native dialog can't be scrolled past. The title names the decision, since
     * which of the two didn't happen is most of the value (connections.md).
     */
    onError: (error, { approve }) =>
      Alert.alert(
        approve ? 'Couldn’t approve that request' : 'Couldn’t reject that request',
        serverMessage(error, WENT_WRONG)
      ),
  });

  const requests = dedupeById(
    query.data?.pages.flatMap((page) => page.results) ?? []
  );

  return (
    <FlatList
      data={requests}
      keyExtractor={(req) => String(req.id)}
      // See DirectoryList: bounce even when short/empty so the pull gesture
      // works on a near-empty Requests inbox.
      alwaysBounceVertical
      contentContainerStyle={styles.listContent}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.accent}
        />
      }
      renderItem={({ item }) => {
        // Gate only the row being acted on, not every button on screen — so
        // approving one request doesn't briefly disable all the others.
        const pending = decide.isPending && decide.variables?.id === item.id;
        return (
          <PersonRow
            person={item.requester}
            trailing={
              <View style={styles.decideRow}>
                <Pressable
                  onPress={() =>
                    decide.mutate({
                      approve: true,
                      id: item.id,
                      requesterId: item.requester.id,
                    })
                  }
                  disabled={pending}
                  accessibilityRole="button"
                  accessibilityLabel={`Approve ${item.requester.display_name}`}
                  style={({ pressed }) => [
                    styles.approve,
                    (pressed || pending) && styles.pressed,
                  ]}
                >
                  <Text style={styles.approveLabel}>Approve</Text>
                </Pressable>
                <Pressable
                  onPress={() =>
                    decide.mutate({
                      approve: false,
                      id: item.id,
                      requesterId: item.requester.id,
                    })
                  }
                  disabled={pending}
                  accessibilityRole="button"
                  accessibilityLabel={`Reject ${item.requester.display_name}`}
                  style={({ pressed }) => [
                    styles.reject,
                    (pressed || pending) && styles.pressed,
                  ]}
                >
                  <Text style={styles.rejectLabel}>Reject</Text>
                </Pressable>
              </View>
            }
          />
        );
      }}
      onEndReached={() => {
        if (query.hasNextPage && !query.isFetchingNextPage) query.fetchNextPage();
      }}
      onEndReachedThreshold={0.5}
      ListEmptyComponent={
        query.isLoading ? (
          <ListMessage>Loading…</ListMessage>
        ) : query.isError ? (
          <ListError
            message={serverMessage(query.error, 'Couldn’t load requests.')}
            onRetry={query.refetch}
          />
        ) : (
          <ListMessage>No pending requests.</ListMessage>
        )
      }
      ListFooterComponent={
        query.isFetchingNextPage ? (
          <ActivityIndicator style={styles.footer} color={colors.accent} />
        ) : null
      }
    />
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  header: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  title: { fontSize: fontSize.lg, fontWeight: '700', color: colors.ink },
  segments: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    marginTop: spacing.sm,
    padding: 3,
    borderRadius: radius.md,
    backgroundColor: 'rgba(28,26,22,0.05)',
    gap: 2,
  },
  segment: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.sm,
  },
  segmentActive: {
    backgroundColor: colors.raised,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  segmentLabel: { fontSize: fontSize.sm, fontWeight: '500', color: colors.inkSoft },
  segmentLabelActive: { color: colors.ink },
  badge: {
    minWidth: 18,
    paddingHorizontal: 5,
    borderRadius: radius.pill,
    backgroundColor: colors.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeActive: { backgroundColor: colors.accent },
  badgeText: { fontSize: 11, fontWeight: '700', color: colors.accentDeep },
  badgeTextActive: { color: '#ffffff' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md - 2,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  rowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minWidth: 0,
  },
  rowName: { flex: 1, fontSize: fontSize.base, fontWeight: '600', color: colors.ink },
  chevron: { paddingHorizontal: spacing.xs },
  chevronGlyph: { fontSize: 24, color: colors.inkFaint, lineHeight: 24 },
  decideRow: { flexDirection: 'row', gap: spacing.sm },
  approve: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  approveLabel: { fontSize: fontSize.sm, fontWeight: '600', color: '#ffffff' },
  reject: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.raised,
  },
  rejectLabel: { fontSize: fontSize.sm, fontWeight: '600', color: colors.ink },
  pressed: { opacity: 0.7 },
  // flexGrow so a short/empty list still fills the viewport — needed for the
  // overscroll pull gesture, and it lets the empty states centre themselves.
  listContent: { flexGrow: 1 },
  message: { flex: 1, padding: spacing.xl, alignItems: 'center', justifyContent: 'center' },
  messageText: {
    fontSize: fontSize.sm,
    color: colors.inkFaint,
    textAlign: 'center',
    lineHeight: 20,
  },
  messageError: { color: colors.danger },
  retry: {
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  retryText: { color: colors.ink, fontWeight: '600' },
  emptyBlock: {
    flex: 1,
    padding: spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  primaryBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  primaryBtnLabel: { fontSize: fontSize.sm, fontWeight: '600', color: '#ffffff' },
  footer: { marginVertical: spacing.lg },
});
