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
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api, ApiError } from '@/api';
import { CommentThread } from '@/components/CommentThread';
import { PostCard } from '@/components/PostCard';
import { markPostCommentsSeen } from '@/postCache';
import { colors, fontSize, spacing } from '@/theme';

export default function PostScreen() {
  const { postId, comment } = useLocalSearchParams<{
    postId: string;
    comment?: string;
  }>();

  const id = Number(postId);
  const highlightCommentId = comment ? Number(comment) : null;

  const queryClient = useQueryClient();
  const scrollRef = useRef<ScrollView>(null);
  // Where the post itself ends, so a comment's offset within the thread can be
  // turned into an offset within the page.
  const [threadTop, setThreadTop] = useState(0);
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
   * Opening the thread is the "seen" event.
   *
   * The comments GET stamps the server-side marker, so the "N new" badge the
   * feed is still showing for this post is already stale. Mirror that reset into
   * the cache instead of refetching the feed to be told what we know.
   */
  useEffect(() => {
    if (post) markPostCommentsSeen(queryClient, id);
  }, [post, id, queryClient]);

  /**
   * Scroll a deep-linked comment into view, once.
   *
   * `scrolled` guards against re-running when the thread re-renders (a reply
   * posted, a reaction toggled) — yanking someone back to the notification's
   * target while they're reading further down would be maddening.
   */
  const onHighlightLayout = useCallback(
    (y: number) => {
      if (scrolled.current) return;
      scrolled.current = true;
      scrollRef.current?.scrollTo({
        y: Math.max(0, threadTop + y - 80),
        animated: true,
      });
    },
    [threadTop]
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
                style={styles.thread}
                onLayout={(event) => setThreadTop(event.nativeEvent.layout.y)}
              >
                <CommentThread
                  postId={id}
                  highlightCommentId={highlightCommentId}
                  onHighlightLayout={onHighlightLayout}
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
  thread: { paddingHorizontal: spacing.md, marginTop: spacing.sm },
  centre: { padding: spacing.xl, alignItems: 'center', gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.base, fontWeight: '600', color: colors.ink },
  emptyBody: {
    fontSize: fontSize.sm,
    color: colors.inkSoft,
    textAlign: 'center',
    lineHeight: 20,
  },
});
