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
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api, ApiError, serverMessage, WENT_WRONG } from '@/api';
import { useAuth } from '@/auth';
import { Avatar } from '@/components/Avatar';
import { SettingsIcon } from '@/components/icons';
import { BlockButton } from '@/components/BlockButton';
import { ConnectButton } from '@/components/ConnectButton';
import { KeyboardAvoider } from '@/components/KeyboardAvoider';
import { MessageButton } from '@/components/MessageButton';
import { ProfileEditForm } from '@/components/ProfileEditForm';
import { TimelineList } from '@/components/TimelineList';
import { toRows } from '@/feed';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { Post } from '@/types';
import { useAndroidBack } from '@/useAndroidBack';
import { useDayBoundary } from '@/useDayBoundary';
import { useHoldSwipeBack, useWriteHold, WriteHoldProvider } from '@/writeHold';

export default function ProfileScreen() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const id = Number(userId);
  const { user: me, signOut } = useAuth();
  const isSelf = me?.pk === id;

  const [editing, setEditing] = useState(false);

  /**
   * Every way off this screen is held while the editor has its PATCH out
   * (#256/#259) — the form is the only renderer of a refused save, and all four
   * routes below unmount it.
   *
   * The editor declares the write; this screen owns the routes. `useAndroidBack`
   * is registered *here*, on the state the form doesn't own, which is the
   * structural cause #256 names: the two could never agree because the flag
   * wasn't in scope.
   *
   * Only the swipe hold is taken from `writeHold` — a second `useAndroidBack`
   * for the same press would race the one below on hook order, so that one
   * declines instead.
   */
  const hold = useWriteHold();
  useHoldSwipeBack(hold.held);

  // Android back closes the inline editor instead of the profile — the same
  // thing the form's Cancel does. Without it the press leaves the screen and
  // the half-typed bio goes with it (#168).
  useAndroidBack(editing, () => {
    if (hold.held) return;
    setEditing(false);
  });

  // Only *other* people's profiles need this fetch — your own header renders
  // from the auth `me` (kept fresh by refreshUser), and `canSeePosts` below
  // short-circuits on `isSelf`, so getUser(you) would be a round-trip whose
  // result is never read. Skip it.
  const userQuery = useQuery({
    queryKey: ['user', id],
    queryFn: () => api.getUser(id),
    enabled: !isSelf,
  });

  const user = userQuery.data;
  // Private-by-default: your own posts are always visible to you; everyone
  // else's only once you're mutually connected.
  const canSeePosts = isSelf || user?.connection_status === 'connected';

  const postsQuery = useInfiniteQuery({
    queryKey: ['userPosts', id],
    queryFn: ({ pageParam }) =>
      pageParam ? api.getPage<Post>(pageParam) : api.getUserPosts(id),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
    // Fetch posts only once we know we may see them: your own always, someone
    // else's not until `connection_status` comes back `connected`. A stranger's
    // posts are never requested — the backend would return them empty, and
    // skipping the call keeps the locked state from flashing a spinner first.
    enabled: canSeePosts,
  });

  /**
   * **A profile with no posts and one we couldn't ask about are different
   * things** (#317). This screen reads `userQuery.isError` for the header but
   * never `postsQuery`'s, so a failed timeline fetch left `data` undefined, the
   * `?? []` below made that an empty array, and the empty state named a person
   * while it said it: "*Ada* hasn't posted yet" — under a header that had loaded
   * perfectly, because it is a different query. Worse on your **own** profile,
   * where `userQuery` is disabled entirely and the sentence becomes "You haven't
   * posted yet", said to you about your own timeline.
   *
   * `&& !data`, never a bare `isError`: a failed *refresh* keeps the posts
   * already on screen (#309/#311), exactly as the header above it does.
   */
  const postsLoadFailed = postsQuery.isError && !postsQuery.data;

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

  const goBack = () => {
    // Leaving takes the editor — and the refusal it is the only renderer of —
    // with it. The control renders unavailable too; this is the backstop.
    if (hold.held) return;
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  // A real 404 means "no such user"; a transient 5xx/network error must not
  // masquerade as that, so it gets a retry instead of telling someone a user who
  // exists doesn't.
  const notFound =
    userQuery.error instanceof ApiError && userQuery.error.status === 404;

  // Whether there is a profile to draw at all — either one the query has (even
  // a stale one whose last refetch failed) or your own, which renders from the
  // auth `me` with the fetch disabled. This, not the query flags, is what
  // decides between the page and a placeholder.
  const hasProfile = isSelf || !!user;

  const header = (
    <View style={styles.profileHeader}>
      {isSelf && editing ? (
        <WriteHoldProvider hold={hold}>
          <ProfileEditForm onDone={() => setEditing(false)} />
        </WriteHoldProvider>
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
            ) : user && user.is_blocked ? (
              // Once you've blocked someone the only action is to unblock; Connect
              // and Message make no sense (the block severed the connection and
              // bars messaging), so they're replaced by an explanation — mirroring
              // the web ProfilePage.
              <>
                <View style={styles.actions}>
                  <BlockButton
                    userId={id}
                    displayName={user.display_name}
                    isBlocked
                  />
                </View>
                <Text style={styles.blockedNote}>
                  You’ve blocked {user.display_name}. They can’t message you or see
                  your posts, and you can’t see theirs.
                </Text>
              </>
            ) : user ? (
              // The connection control (E1), the Message button once connected
              // (E2), and Block as a quieter secondary action (E4a). ConnectButton's
              // mutation invalidates ['user', id] + ['userPosts', id], so
              // accepting/connecting here flips both the posts wall and whether
              // Message shows without leaving the screen.
              <>
                <View style={styles.actions}>
                  <ConnectButton
                    userId={id}
                    displayName={user.display_name}
                    connectionStatus={user.connection_status}
                    size="md"
                  />
                  {user.connection_status === 'connected' && (
                    <MessageButton userId={id} />
                  )}
                </View>
                <View style={styles.blockRow}>
                  <BlockButton
                    userId={id}
                    displayName={user.display_name}
                    isBlocked={false}
                  />
                </View>
              </>
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
          disabled={hold.held}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={8}
        >
          <Text style={[styles.back, hold.held && styles.backDisabled]}>
            ← Back
          </Text>
        </Pressable>
        {/* Settings lives behind a gear on your own profile — five tabs is the
            iOS max and already full, so account controls get a non-tab home
            here, beside where logout lives (phase plan, E4 nav decision). */}
        {isSelf ? (
          <Pressable
            onPress={() => router.push('/settings')}
            accessibilityRole="button"
            accessibilityLabel="Settings"
            hitSlop={8}
          >
            <SettingsIcon color={colors.inkSoft} />
          </Pressable>
        ) : null}
      </View>

      {/* **The profile we have beats an error about refreshing it** — the same
          rule `CommentThread` and the post screen follow. A failed refetch keeps
          its data and only flips `status` to 'error', and that refetch is
          routine: `staleTime` is 0 and every foreground refetches this key, so
          reading `isError` before the data replaced a whole loaded profile with
          an error card the moment the app came back on patchy signal.
          A 404 still wins over the cached copy — deleted or out of reach is a
          real answer about *now*. `isSelf` renders from the auth `me` with the
          fetch disabled, so it counts as having content of its own. */}
      {notFound ? (
        <View style={styles.centre}>
          <Text style={styles.emptyTitle}>User not found</Text>
          <Text style={styles.emptyBody}>No one here goes by that id.</Text>
        </View>
      ) : !hasProfile ? (
        userQuery.isError ? (
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
          <ActivityIndicator color={colors.accent} style={styles.spinner} />
        )
      ) : (
        <KeyboardAvoider style={styles.fill}>
          <TimelineList
            rows={canSeePosts ? rows : []}
            // The editor's inputs and Save/Cancel live in the header; `handled`
            // is what lets a tap on those buttons land while the keyboard is up.
            keyboardShouldPersistTaps="handled"
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
              ) : postsLoadFailed ? (
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
              ) : postsQuery.isError && rows.length > 0 ? (
                // The partial case (`EventPhotos`' shape): a timeline that
                // stopped short looks exactly like one that ended, which here
                // quietly under-states how much someone has posted.
                //
                // Keyed off the rendered rows, not off `postsQuery.data`. A
                // timeline that loaded and is genuinely empty has `data` and no
                // rows, so a failed refresh of *that* would print this line
                // directly under "Ada hasn't posted yet" — two claims at once,
                // the second of them wrong twice over since no posts loaded to
                // be older than.
                <Text style={styles.inlineError}>
                  Couldn’t load any older posts.
                </Text>
              ) : null
            }
          />
        </KeyboardAvoider>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  fill: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  back: { fontSize: fontSize.sm, color: colors.inkFaint, fontWeight: '600' },
  // Rendered unavailable rather than silently declining: a Back that does
  // nothing when pressed reads as a broken app, not as a deliberate hold.
  backDisabled: { opacity: 0.4 },
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
  actions: { marginTop: spacing.sm, flexDirection: 'row', gap: spacing.sm },
  // Block is a quieter, secondary action, so it sits on its own line below the
  // primary connect/message row (as on the web), left-aligned.
  blockRow: { marginTop: spacing.xs, flexDirection: 'row', alignSelf: 'flex-start' },
  blockedNote: {
    marginTop: spacing.sm,
    fontSize: fontSize.sm,
    color: colors.inkFaint,
    lineHeight: 20,
  },
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
  pressed: { opacity: 0.7 },
  // The quieter form: a line under posts that did load, saying what didn't.
  inlineError: {
    marginVertical: spacing.lg,
    paddingHorizontal: spacing.md,
    fontSize: fontSize.sm,
    color: colors.danger,
    textAlign: 'center',
    lineHeight: 20,
  },
  footer: { marginVertical: spacing.lg },
});
