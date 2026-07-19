/**
 * A single person's profile — their details, then their own posts, newest-first.
 *
 * People are identified by numeric id in the URL (`/u/123`); there is no
 * username in this product. The same screen serves everyone: your own profile
 * gets an inline editor and a logout, everyone else's gets a read-only header.
 *
 * **Post visibility is private by default and enforced server-side.** Unless
 * it's you or a connection, `getUserPosts` comes back empty and this screen
 * shows a locked explanation rather than their timeline (see connections.md).
 * The Connect / Message / Block actions that would let you *change* that
 * relationship are Milestone E (connections/block); C4 reads `connection_status`
 * only to pick the right locked message, and doesn't yet render those buttons.
 *
 * Reached by pushing onto the stack (from your bead in the feed header, or an
 * author's bead/name on any post), so each visit is a fresh mount — the inline
 * editor's open/closed state can't leak between two different people.
 */

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api, ApiError } from '@/api';
import { useAuth } from '@/auth';
import { Avatar } from '@/components/Avatar';
import { ProfileEditForm } from '@/components/ProfileEditForm';
import { TimelineList } from '@/components/TimelineList';
import { toRows } from '@/feed';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { Post } from '@/types';
import { useDayBoundary } from '@/useDayBoundary';

export default function ProfileScreen() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const id = Number(userId);
  const { user: me, signOut } = useAuth();
  const isSelf = me?.pk === id;

  const [editing, setEditing] = useState(false);

  const userQuery = useQuery({
    queryKey: ['user', id],
    queryFn: () => api.getUser(id),
  });

  const postsQuery = useInfiniteQuery({
    queryKey: ['userPosts', id],
    queryFn: ({ pageParam }) =>
      pageParam ? api.getPage<Post>(pageParam) : api.getUserPosts(id),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
    // Don't fetch someone's posts until we know we're allowed to see them —
    // the backend returns empty for a stranger anyway, but skipping the call
    // keeps the locked state from flickering a spinner first.
    enabled: userQuery.isSuccess,
  });

  // `today` changes at midnight and is what re-derives the day-divider labels.
  const today = useDayBoundary();
  const rows = useMemo(
    () => toRows(postsQuery.data?.pages.flatMap((page) => page.results) ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- today is a trigger
    [postsQuery.data, today]
  );

  function confirmSignOut() {
    Alert.alert('Log out?', 'You’ll need your password to log back in.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log out', style: 'destructive', onPress: signOut },
    ]);
  }

  const goBack = () =>
    router.canGoBack() ? router.back() : router.replace('/');

  // A real 404 means "no such user"; a transient 5xx/network error must not
  // masquerade as that, so it gets a retry instead of telling someone a user who
  // exists doesn't.
  const notFound =
    userQuery.error instanceof ApiError && userQuery.error.status === 404;

  const user = userQuery.data;
  // Private-by-default: your own posts are always visible to you; everyone
  // else's only once you're mutually connected.
  const canSeePosts = isSelf || user?.connection_status === 'connected';

  const header = (
    <View style={styles.profileHeader}>
      {isSelf && editing ? (
        <ProfileEditForm onDone={() => setEditing(false)} />
      ) : (
        <View style={styles.headerRow}>
          {/* For self the auth user is the freshest source (refreshUser keeps it
              current after an edit); for others it's the fetched profile. */}
          <Avatar user={isSelf ? me : user} size="lg" />
          <View style={styles.headerBody}>
            <View style={styles.nameRow}>
              <Text style={styles.name} numberOfLines={2}>
                {isSelf ? me?.display_name : user?.display_name}
              </Text>
              {isSelf ? (
                <Pressable
                  onPress={() => setEditing(true)}
                  accessibilityRole="button"
                  style={styles.ghostButton}
                >
                  <Text style={styles.ghostLabel}>Edit profile</Text>
                </Pressable>
              ) : null}
            </View>
            {(isSelf ? me?.bio : user?.bio) ? (
              <Text style={styles.bio}>{isSelf ? me?.bio : user?.bio}</Text>
            ) : null}
            {isSelf ? (
              <Pressable
                onPress={confirmSignOut}
                accessibilityRole="button"
                accessibilityLabel="Log out"
                style={styles.logout}
              >
                <Text style={styles.logoutLabel}>Log out</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      )}
    </View>
  );

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
      </View>

      {userQuery.isLoading ? (
        <ActivityIndicator color={colors.accent} style={styles.spinner} />
      ) : notFound ? (
        <View style={styles.centre}>
          <Text style={styles.emptyTitle}>User not found</Text>
          <Text style={styles.emptyBody}>No one here goes by that id.</Text>
        </View>
      ) : userQuery.isError ? (
        <View style={styles.centre}>
          <Text style={styles.emptyTitle}>Couldn’t load this profile</Text>
          <Text style={styles.emptyBody}>
            {userQuery.error instanceof Error
              ? userQuery.error.message
              : 'Something went wrong.'}
          </Text>
          <Pressable style={styles.retry} onPress={() => userQuery.refetch()}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <KeyboardAvoidingView
          style={styles.fill}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <TimelineList
            rows={canSeePosts ? rows : []}
            ListHeaderComponent={header}
            onEndReached={() => {
              if (postsQuery.hasNextPage && !postsQuery.isFetchingNextPage) {
                postsQuery.fetchNextPage();
              }
            }}
            ListEmptyComponent={
              !canSeePosts ? (
                <View style={styles.locked}>
                  <Text style={styles.emptyTitle}>
                    {user?.display_name}’s posts are private.
                  </Text>
                  <Text style={styles.emptyBody}>
                    {user?.connection_status === 'requested'
                      ? 'Your connection request is waiting for approval.'
                      : user?.connection_status === 'incoming'
                        ? `${user?.display_name} asked to connect — approve to see each other’s posts.`
                        : 'Once you’re connected, you’ll see each other’s posts here.'}
                  </Text>
                </View>
              ) : postsQuery.isLoading ? (
                <ActivityIndicator color={colors.accent} style={styles.spinner} />
              ) : (
                <View style={styles.locked}>
                  <Text style={styles.emptyBody}>
                    {isSelf
                      ? 'You haven’t posted yet.'
                      : `${user?.display_name} hasn’t posted yet.`}
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
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  fill: { flex: 1 },
  topBar: { paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
  back: { fontSize: fontSize.sm, color: colors.inkFaint, fontWeight: '600' },
  profileHeader: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  headerBody: { flex: 1, gap: spacing.xs },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  name: {
    flexShrink: 1,
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.ink,
  },
  bio: { fontSize: fontSize.base, color: colors.inkSoft, lineHeight: 22 },
  ghostButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.md,
  },
  ghostLabel: { fontSize: fontSize.sm, fontWeight: '600', color: colors.ink },
  logout: { marginTop: spacing.sm, alignSelf: 'flex-start' },
  logoutLabel: { fontSize: fontSize.sm, fontWeight: '600', color: colors.danger },
  spinner: { marginTop: spacing.xl },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.sm },
  locked: { padding: spacing.xl, alignItems: 'center', gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.base, fontWeight: '600', color: colors.ink },
  emptyBody: {
    fontSize: fontSize.sm,
    color: colors.inkSoft,
    textAlign: 'center',
    lineHeight: 20,
  },
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
