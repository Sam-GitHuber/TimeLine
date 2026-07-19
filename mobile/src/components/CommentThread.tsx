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
import { useState } from 'react';
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
  const {
    data: comments,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['comments', postId],
    queryFn: () => api.getComments(postId),
  });

  const expandIds =
    highlightCommentId != null && comments
      ? ancestorIdsOf(comments, highlightCommentId)
      : null;

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

  function handleLayout(event: LayoutChangeEvent) {
    // Only the deep-link target reports its position, and only to its own
    // parent — the screen adds up the offsets as they bubble, which is the only
    // way to locate a nested view without measuring the whole tree.
    if (isHighlighted) onHighlightLayout?.(event.nativeEvent.layout.y);
  }

  return (
    <View
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
        <View style={styles.replies}>
          {replies.map((reply) => (
            <CommentNode
              key={reply.id}
              comment={reply}
              postId={postId}
              expandIds={expandIds}
              highlightId={highlightId}
              onHighlightLayout={onHighlightLayout}
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
