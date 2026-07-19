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

import { useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api, ApiError } from '@/api';
import { CommentThread } from '@/components/CommentThread';
import { PostCard } from '@/components/PostCard';
import { SPINE_COLUMN } from '@/components/timeline';
import { colors, fontSize, spacing } from '@/theme';

export default function PostScreen() {
  const { postId, comment } = useLocalSearchParams<{
    postId: string;
    comment?: string;
  }>();

  const id = Number(postId);
  const highlightCommentId = comment ? Number(comment) : null;

  const scrollRef = useRef<ScrollView>(null);
  // Where the post itself ends, so a comment's offset within the thread can be
  // turned into an offset within the page. A ref, not state: it feeds an
  // imperative scroll, nothing renders from it, and keeping it out of the
  // dependency graph is what lets the callback below stay stable.
  const threadTop = useRef<number | null>(null);
  const pendingY = useRef<number | null>(null);
  const scrolled = useRef(false);

  const {
    data: post,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['post', String(id)],
    queryFn: () => api.getPost(id),
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

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <Pressable
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          accessibilityRole="button"
          accessibilityLabel="Back to feed"
          hitSlop={8}
        >
          <Text style={styles.back}>← Feed</Text>
        </Pressable>
      </View>

      <KeyboardAvoidingView
        style={styles.fill}
        // Without this the keyboard covers the comment box you're typing in —
        // the single most common way a mobile comment form feels broken.
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          {isLoading ? (
            <ActivityIndicator color={colors.accent} style={styles.spinner} />
          ) : notFound ? (
            <View style={styles.centre}>
              <Text style={styles.emptyTitle}>Post not available</Text>
              <Text style={styles.emptyBody}>
                This post doesn’t exist, or you don’t have access to it.
              </Text>
            </View>
          ) : error ? (
            <View style={styles.centre}>
              <Text style={styles.emptyTitle}>Couldn’t load this post</Text>
              <Text style={styles.emptyBody}>
                {error instanceof Error ? error.message : 'Something went wrong.'}
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
                <CommentThread
                  postId={id}
                  highlightCommentId={highlightCommentId}
                  onHighlightLayout={scrollToThreadOffset}
                />
              </View>
            </>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  fill: { flex: 1 },
  header: { paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
  back: { fontSize: fontSize.sm, color: colors.inkFaint, fontWeight: '600' },
  content: { paddingBottom: spacing.xxl },
  spinner: { marginTop: spacing.xl },
  thread: {
    // Line the thread up with the post's own text column rather than with the
    // screen edge, so a comment reads as hanging off the same entry. Derived
    // from the shared geometry — PostCard indents its content by exactly this.
    paddingLeft: SPINE_COLUMN + spacing.sm,
    paddingRight: spacing.md,
    marginTop: spacing.sm,
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
