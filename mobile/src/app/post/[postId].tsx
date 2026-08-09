/**
 * One post on its own screen — the permalink.
 *
 * **This route is what push notifications open** (Milestone D): every one of the
 * eleven notification kinds that concerns a post or a comment deep-links to
 * `/post/[postId]`, with `?comment=<id>` naming a specific reply. So it has to
 * stand on its own from a cold start — it fetches the post by id rather than
 * expecting it to be sitting in some feed page, because the target of a "someone
 * replied" tap is often an old post nowhere near page one.
 *
 * Visibility is enforced server-side, and a post you can't see returns **404,
 * not 403** — the app must not become a way to discover that a post exists.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api, ApiError, serverMessage, WENT_WRONG } from '@/api';
import { CommentThread } from '@/components/CommentThread';
import {
  KeyboardAwareScroll,
  type KeyboardAwareScrollRef,
} from '@/components/KeyboardAvoider';
import { PostCard } from '@/components/PostCard';
import { mirrorPostSeen } from '@/seenMirror';
import { colors, fontSize, spacing } from '@/theme';
import { useHoldSwipeBack, useWriteHold, WriteHoldProvider } from '@/writeHold';

export default function PostScreen() {
  const { postId, comment } = useLocalSearchParams<{
    postId: string;
    comment?: string;
  }>();

  const id = Number(postId);
  const highlightCommentId = comment ? Number(comment) : null;

  const scrollRef = useRef<KeyboardAwareScrollRef>(null);
  // Where the post itself ends, so a comment's offset within the thread can be
  // turned into an offset within the page. A ref, not state: it feeds an
  // imperative scroll, nothing renders from it, and keeping it out of the
  // dependency graph is what lets the callback below stay stable.
  const threadTop = useRef<number | null>(null);
  const pendingY = useRef<number | null>(null);
  const scrolled = useRef(false);

  // Declared above the query because the query's own `queryFn` uses it — see
  // the seen-mirror note there.
  const queryClient = useQueryClient();

  const {
    data: post,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['post', String(id)],
    /**
     * **The seen-mirror is bolted to the request, not to a render (#318).**
     *
     * This GET marks every unread notification pointing at this post — or at
     * any comment on it — seen server-side (viewing is seeing), so the local
     * mirror of that stamp has to be the resolution of *this* GET. What it
     * mirrors, and why it may not throw, is written up in `seenMirror.ts`;
     * `CommentThread`'s own fetch calls the same function, because the comments
     * GET stamps too.
     *
     * It lived in an effect gated on `!!post` until #318, and an effect on
     * `data` is not the same thing — the mistake `CommentThread` had made one
     * level down and fixed in #308. `useQuery` hands back a cached post
     * *synchronously*, and the default `gcTime` is five minutes, so tapping a
     * push for a post you read a moment ago fired the effect on that stale copy
     * before the mount refetch had been anywhere near the server. If the
     * refetch then 404'd — the post deleted, or its author since disconnected
     * — the screen said *Post not available* **and** the notification that
     * would have brought you back, plus the badge behind it, were already gone.
     * A guard couldn't close it: on that first commit `notFound` is false,
     * because a cached entry carries no error yet.
     *
     * Here, a 404 rejects before reaching the mirror and a cached render never
     * runs it at all. The trade is that this runs on **every** successful fetch
     * rather than once per mount, which is the right way round: the *server*
     * stamps on every one of those fetches too, so mirroring once per mount
     * left the app's tray and badge lagging its own backend.
     *
     * `id`, not `post.id`: they are equal by construction — `id` is what the
     * key and the request are built from — and a property read is the one thing
     * in here that could throw.
     */
    queryFn: async () => {
      const fetched = await api.getPost(id);
      mirrorPostSeen(queryClient, id);
      return fetched;
    },
    // A 404 here is a real answer ("you can't see this"), not a blip worth
    // retrying — and retrying would just delay the message.
    retry: false,
  });

  /**
   * Scroll a deep-linked comment into view, once.
   *
   * `scrolled` guards against re-running when the thread re-renders (a reply
   * posted, a reaction toggled) — yanking someone back to the notification's
   * target while they're reading further down would be maddening.
   *
   * **The guard must not latch before we can actually aim.** The thread reports
   * the target's offset from its own top, which is only useful once we know
   * where the thread starts — and React Native lays the thread's children out
   * before the thread itself, so the offset almost always arrives first. Marking
   * the scroll done on that early call left it short by the whole height of the
   * post, permanently. So an offset that arrives too early is parked, and the
   * thread's own layout flushes it.
   */
  const scrollToThreadOffset = useCallback((y: number) => {
    if (scrolled.current) return;
    if (threadTop.current == null) {
      pendingY.current = y;
      return;
    }
    scrolled.current = true;
    scrollRef.current?.scrollTo({
      // A little headroom above the target, so it reads as part of a
      // conversation rather than jammed against the top of the screen.
      y: Math.max(0, threadTop.current + y - 80),
      animated: true,
    });
  }, []);

  /**
   * The guard belongs to the **target**, not the screen (#177).
   *
   * A tapped push now reuses this screen instead of stacking a second copy of
   * it, so a *different* comment on a post already on display arrives as a param
   * change with no remount. A guard latched by the first deep link would leave
   * the new target highlighted somewhere off-screen — the notification would
   * look answered while showing the wrong thing. Re-arming on the id is enough
   * to aim again: highlighting adds a border and padding, so the newly targeted
   * comment changes height and re-reports its offset through `onLayout`.
   *
   * Only on a change, so the "don't yank a reader back" property above survives:
   * a re-render with the same target re-runs nothing.
   */
  useEffect(() => {
    scrolled.current = false;
    pendingY.current = null;
  }, [highlightCommentId]);

  const handleThreadLayout = useCallback(
    (event: LayoutChangeEvent) => {
      threadTop.current = event.nativeEvent.layout.y;
      if (pendingY.current != null) {
        const buffered = pendingY.current;
        pendingY.current = null;
        scrollToThreadOffset(buffered);
      }
    },
    [scrollToThreadOffset]
  );

  const notFound = error instanceof ApiError && error.status === 404;

  /**
   * A comment edit or a reply reports its refusal inside its own write box and
   * nowhere else, so leaving the post takes the message with it (#256).
   *
   * `CommentNode` already holds the routes it owns — Cancel, Android's back, the
   * Reply toggle — and its hold forwards up to this one, which owns the two it
   * can't see: "← Feed" and iOS's swipe-back. Android's back is claimed by the
   * node's own registration, so only the swipe is taken here; a second handler
   * for the same press would be the hook-order race `writeHold.tsx` warns about.
   */
  const hold = useWriteHold();
  useHoldSwipeBack(hold.held);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <Pressable
          onPress={() => {
            // The control renders unavailable too; this is the backstop.
            if (hold.held) return;
            if (router.canGoBack()) router.back();
            else router.replace('/');
          }}
          disabled={hold.held}
          accessibilityRole="button"
          accessibilityLabel="Back to feed"
          hitSlop={8}
        >
          <Text style={[styles.back, hold.held && styles.backDisabled]}>
            ← Feed
          </Text>
        </Pressable>
      </View>

      {/* Without this the keyboard covers the comment box you're typing in —
          the single most common way a mobile comment form feels broken. */}
      <KeyboardAwareScroll
        style={styles.fill}
        ref={scrollRef}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* **The post we have beats an error about refreshing it**, which is the
            same rule `CommentThread` follows one level down — and it has to hold
            here too, or the thread's own care is undone from above. A failed
            refetch of `['post', id]` keeps its data and flips `status` to
            'error', and that refetch is *routine*: posting a comment
            invalidates this very key (`invalidateComments`), and every
            foreground does too. Returning on `error` first therefore replaced
            the card, the thread and a half-typed reply with an error panel a
            second after a comment went through on a patchy connection.
            A 404 still wins over the cached copy: that's the post having been
            deleted or taken out of reach, which is a real answer about *now*. */}
        {notFound ? (
          <View style={styles.centre}>
            <Text style={styles.emptyTitle}>Post not available</Text>
            <Text style={styles.emptyBody}>
              This post doesn’t exist, or you don’t have access to it.
            </Text>
          </View>
        ) : post ? (
          <>
            <PostCard post={post} interactive={false} />
            <View
              testID="thread"
              style={styles.thread}
              onLayout={handleThreadLayout}
            >
              <WriteHoldProvider hold={hold}>
                <CommentThread
                  target={{ postId: id }}
                  highlightCommentId={highlightCommentId}
                  onHighlightLayout={scrollToThreadOffset}
                />
              </WriteHoldProvider>
            </View>
          </>
        ) : error ? (
          <View style={styles.centre}>
            <Text style={styles.emptyTitle}>Couldn’t load this post</Text>
            <Text style={styles.emptyBody}>
              {serverMessage(error, WENT_WRONG)}
            </Text>
          </View>
        ) : isLoading ? (
          <ActivityIndicator color={colors.accent} style={styles.spinner} />
        ) : null}
      </KeyboardAwareScroll>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  fill: { flex: 1 },
  header: { paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
  back: { fontSize: fontSize.sm, color: colors.inkFaint, fontWeight: '600' },
  // Unavailable rather than silently declining — a dead Back reads as broken.
  backDisabled: { opacity: 0.4 },
  content: { paddingBottom: spacing.xxl },
  spinner: { marginTop: spacing.xl },
  thread: {
    // Only the right inset. The thread draws its own join off the post's spine
    // and owns the left indent that goes with it (CommentThread's geometry
    // notes) — a margin or padding here would break that line.
    paddingRight: spacing.md,
  },
  centre: { padding: spacing.xl, alignItems: 'center', gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.base, fontWeight: '600', color: colors.ink },
  emptyBody: {
    fontSize: fontSize.sm,
    color: colors.inkSoft,
    textAlign: 'center',
    lineHeight: 20,
  },
});
