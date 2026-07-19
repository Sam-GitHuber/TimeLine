/**
 * A post's comment tree, and the boxes for adding to it.
 *
 * **The tree arrives already pruned.** You only ever receive comments from
 * people you're connected with — a not-connected author's comment *and its
 * whole subtree* are dropped server-side (connections.md), so there is nothing
 * hidden here to filter and no risk of leaking a stranger by rendering what we
 * were sent. Render it as it comes.
 *
 * Replies start **collapsed**, as on the web: a busy post then opens as a clean
 * list of top-level comments and you drill into the one sub-thread you want,
 * rather than facing a wall of nesting. Opening the reply box, or having just
 * replied, reveals the sub-thread so your own reply is never hidden.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
} from 'react-native';

import { api } from '@/api';
import { Avatar } from './Avatar';
import { ReactionBar } from './ReactionBar';
import { markPostCommentsSeen } from '@/postCache';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { Comment } from '@/types';
import { formatRelativeTime } from '@/utils';

/**
 * The ids of every comment *above* `targetId` in the tree.
 *
 * Replies start collapsed, so a deep-linked reply twenty levels down would open
 * hidden inside its collapsed ancestors. Expanding exactly that trail — and
 * nothing else — reveals it without blowing the whole thread open.
 */
export function ancestorIdsOf(comments: Comment[], targetId: number): Set<number> {
  const found = new Set<number>();

  function walk(nodes: Comment[], trail: number[]): boolean {
    for (const node of nodes) {
      if (node.id === targetId) {
        trail.forEach((id) => found.add(id));
        return true;
      }
      if (node.replies.length && walk(node.replies, [...trail, node.id])) {
        return true;
      }
    }
    return false;
  }

  walk(comments, []);
  return found;
}

export function CommentThread({
  postId,
  highlightCommentId = null,
  onHighlightLayout,
}: {
  postId: number;
  /** From a notification deep link — auto-expanded, highlighted, scrolled to. */
  highlightCommentId?: number | null;
  /** Reports where the highlighted comment landed, so the screen can scroll. */
  onHighlightLayout?: (y: number) => void;
}) {
  const queryClient = useQueryClient();

  const {
    data: comments,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['comments', postId],
    queryFn: () => api.getComments(postId),
  });

  /**
   * Mirror the server's "seen" stamp into the cache — but only once the GET that
   * *does* the stamping has actually succeeded.
   *
   * This lives here rather than on the screen for that reason: the stamp is a
   * side effect of this request, so anything else keying off it can get out of
   * step. Clearing the badge when the *post* loaded meant a failed comments
   * request left the feed showing nothing new while the server still had the
   * thread unseen — the comments were then invisible until something else
   * refetched. Same rule as the web, which marks seen on the open-comments
   * action rather than on the post render (frontend/src/components/PostCard.jsx).
   */
  useEffect(() => {
    if (comments) markPostCommentsSeen(queryClient, postId);
  }, [comments, postId, queryClient]);

  // Memoised because it walks the whole tree: without this, every keystroke in
  // the composer below re-walks it and hands every node a fresh Set.
  const expandIds = useMemo(
    () =>
      highlightCommentId != null && comments
        ? ancestorIdsOf(comments, highlightCommentId)
        : null,
    [comments, highlightCommentId]
  );

  if (isLoading) {
    return <ActivityIndicator color={colors.accent} style={styles.loading} />;
  }

  if (error) {
    return (
      <Text style={styles.error}>
        {error instanceof Error ? error.message : 'Couldn’t load comments.'}
      </Text>
    );
  }

  return (
    <View style={styles.thread}>
      {comments && comments.length > 0 ? (
        comments.map((comment) => (
          <CommentNode
            key={comment.id}
            comment={comment}
            postId={postId}
            expandIds={expandIds}
            highlightId={highlightCommentId}
            onHighlightLayout={onHighlightLayout}
          />
        ))
      ) : (
        <Text style={styles.empty}>No comments yet. Start the conversation.</Text>
      )}

      <CommentComposer postId={postId} placeholder="Write a comment…" />
    </View>
  );
}

/** One comment, its reactions, and its replies nested under a thin left rule. */
function CommentNode({
  comment,
  postId,
  expandIds,
  highlightId,
  onHighlightLayout,
  depth = 0,
}: {
  comment: Comment;
  postId: number;
  expandIds: Set<number> | null;
  highlightId: number | null;
  onHighlightLayout?: (y: number) => void;
  depth?: number;
}) {
  const replies = comment.replies ?? [];
  const [showReply, setShowReply] = useState(false);
  const [collapsed, setCollapsed] = useState(
    replies.length > 0 && !(expandIds?.has(comment.id) ?? false)
  );
  const isHighlighted = highlightId != null && comment.id === highlightId;

  /**
   * Where the deep-link target sits, summed on the way up the tree.
   *
   * `onLayout` reports a view's offset **within its immediate parent**, so a
   * nested reply's own `y` is a few points inside its parent's replies block —
   * useless on its own. Each ancestor therefore adds its own offset as the
   * report passes through, and the total that reaches the screen is the target's
   * offset within the whole thread.
   *
   * The buffering is what makes that work: React Native lays children out
   * *before* their parents, so a report almost always arrives while this node
   * still doesn't know its own position. Holding it until our own `onLayout`
   * lands, then flushing, is the difference between a correct offset and one
   * short by every ancestor above it.
   */
  const ownY = useRef<number | null>(null);
  /** The replies block's own offset inside this node — it sits below the text. */
  const repliesY = useRef(0);
  const pendingChildY = useRef<number | null>(null);

  /** A reply's offset within our replies block, lifted to be relative to us. */
  const report = useCallback(
    (childY: number) => {
      if (ownY.current == null) {
        // Raw, not pre-summed: `repliesY` is very likely still unknown at this
        // point, so the arithmetic has to wait for the flush below.
        pendingChildY.current = childY;
        return;
      }
      onHighlightLayout?.(ownY.current + repliesY.current + childY);
    },
    [onHighlightLayout]
  );

  function handleLayout(event: LayoutChangeEvent) {
    ownY.current = event.nativeEvent.layout.y;

    // The target reports itself; everyone else only forwards what came from
    // below, so a thread with no deep link stays silent.
    if (isHighlighted) {
      onHighlightLayout?.(ownY.current);
      return;
    }
    if (pendingChildY.current != null) {
      const buffered = pendingChildY.current;
      pendingChildY.current = null;
      // Safe to sum now: we lay out after our replies block, so `repliesY` has
      // landed by the time we get here.
      onHighlightLayout?.(ownY.current + repliesY.current + buffered);
    }
  }

  return (
    <View
      testID={`comment-${comment.id}`}
      onLayout={onHighlightLayout ? handleLayout : undefined}
      style={[styles.node, isHighlighted && styles.highlighted]}
    >
      <View style={styles.header}>
        <Avatar user={comment.author} size="xs" />
        <Text style={styles.author} numberOfLines={1}>
          {comment.author.display_name}
        </Text>
        <Text style={styles.time}>{formatRelativeTime(comment.created_at)}</Text>
      </View>

      <Text style={styles.text}>{comment.text}</Text>

      <View style={styles.actions}>
        <Pressable
          onPress={() => {
            setShowReply((open) => !open);
            // Engaging with a sub-thread should reveal it — for context, and so
            // the reply you're about to write lands somewhere visible.
            setCollapsed(false);
          }}
          accessibilityRole="button"
          hitSlop={6}
        >
          <Text style={styles.action}>Reply</Text>
        </Pressable>

        {replies.length > 0 ? (
          <Pressable
            onPress={() => setCollapsed((value) => !value)}
            accessibilityRole="button"
            accessibilityState={{ expanded: !collapsed }}
            hitSlop={6}
          >
            <Text style={styles.toggle}>
              {collapsed
                ? `Show ${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`
                : 'Hide replies'}
            </Text>
          </Pressable>
        ) : null}
      </View>

      <ReactionBar commentId={comment.id} reactions={comment.reactions} />

      {showReply ? (
        <CommentComposer
          postId={postId}
          parentId={comment.id}
          autoFocus
          placeholder={`Reply to ${comment.author.display_name}…`}
          onDone={() => setShowReply(false)}
        />
      ) : null}

      {replies.length > 0 && !collapsed ? (
        // A thin rule is the *only* horizontal cost per level. An avatar-width
        // indent per level marches deep threads off the side of a phone.
        <View
          testID={`replies-${comment.id}`}
          style={styles.replies}
          onLayout={
            onHighlightLayout
              ? (event) => {
                  repliesY.current = event.nativeEvent.layout.y;
                }
              : undefined
          }
        >
          {replies.map((reply) => (
            <CommentNode
              key={reply.id}
              comment={reply}
              postId={postId}
              expandIds={expandIds}
              highlightId={highlightId}
              // `report`, not the raw callback: a reply's offset is relative to
              // us, so it has to pass through here to have our own added.
              onHighlightLayout={onHighlightLayout ? report : undefined}
              depth={depth + 1}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * The write box for a comment (`parentId` null) or a reply.
 *
 * On success it invalidates the tree so the new node appears in place, rather
 * than trying to splice it in at the right depth on the client.
 */
function CommentComposer({
  postId,
  parentId = null,
  autoFocus = false,
  placeholder,
  onDone,
}: {
  postId: number;
  parentId?: number | null;
  autoFocus?: boolean;
  placeholder: string;
  onDone?: () => void;
}) {
  const [text, setText] = useState('');
  const queryClient = useQueryClient();

  const { mutate, isPending, error } = useMutation({
    mutationFn: (value: string) =>
      api.addComment(postId, { text: value, parent: parentId }),
    onSuccess: () => {
      setText('');
      queryClient.invalidateQueries({ queryKey: ['comments', postId] });
      // The post's comment_count is now stale wherever it's shown.
      queryClient.invalidateQueries({ queryKey: ['feed'] });
      queryClient.invalidateQueries({ queryKey: ['post', String(postId)] });
      onDone?.();
    },
  });

  const trimmed = text.trim();

  return (
    <View style={styles.composer}>
      <TextInput
        style={styles.input}
        value={text}
        onChangeText={setText}
        placeholder={placeholder}
        placeholderTextColor={colors.inkFaint}
        accessibilityLabel={placeholder}
        multiline
        autoFocus={autoFocus}
        editable={!isPending}
      />

      {error ? (
        <Text style={styles.error}>
          {error instanceof Error ? error.message : 'Couldn’t post. Try again.'}
        </Text>
      ) : null}

      <View style={styles.composerActions}>
        {onDone ? (
          <Pressable onPress={onDone} accessibilityRole="button" hitSlop={6}>
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={() => mutate(trimmed)}
          disabled={!trimmed || isPending}
          style={({ pressed }) => [
            styles.submit,
            pressed && styles.submitPressed,
            (!trimmed || isPending) && styles.submitDisabled,
          ]}
          accessibilityRole="button"
          // Distinct from the "Reply" that *opens* this box — otherwise both a
          // screen reader and a test see two identical buttons on the row.
          accessibilityLabel={parentId ? 'Post reply' : 'Post comment'}
        >
          <Text style={styles.submitText}>
            {isPending ? 'Posting…' : parentId ? 'Reply' : 'Comment'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  thread: { gap: spacing.lg },
  loading: { marginVertical: spacing.lg },
  node: { gap: spacing.xs },
  highlighted: {
    marginHorizontal: -spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.md,
    backgroundColor: colors.accentTint,
    borderWidth: 2,
    borderColor: colors.accent,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  author: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.ink,
    flexShrink: 1,
  },
  time: { fontSize: 11, color: colors.inkFaint },
  text: { fontSize: 15, color: colors.ink, lineHeight: 21 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  action: { fontSize: fontSize.sm, color: colors.inkFaint, fontWeight: '600' },
  toggle: { fontSize: fontSize.sm, color: colors.accentDeep, fontWeight: '600' },
  replies: {
    marginTop: spacing.sm,
    paddingLeft: spacing.md,
    borderLeftWidth: 1,
    borderLeftColor: colors.line,
    gap: spacing.lg,
  },
  composer: { marginTop: spacing.sm, gap: spacing.sm },
  input: {
    minHeight: 40,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    fontSize: fontSize.sm,
    color: colors.ink,
  },
  composerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.md,
  },
  cancel: { fontSize: fontSize.sm, color: colors.inkFaint, fontWeight: '600' },
  submit: {
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
  },
  submitPressed: { backgroundColor: colors.accentDeep },
  submitDisabled: { opacity: 0.4 },
  submitText: { color: colors.raised, fontWeight: '600', fontSize: fontSize.sm },
  empty: { fontSize: fontSize.sm, color: colors.inkFaint },
  error: { fontSize: fontSize.sm, color: colors.danger },
});
