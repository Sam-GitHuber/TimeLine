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
 *
 * **The thread is drawn as a timeline of its own** — the same "living line" idea
 * the feed uses (docs/design-system.md), one level down. A spine runs through the
 * conversation, each comment's avatar is a bead on it, and a sub-thread *branches*
 * off with a curved elbow onto a spine of its own. See "the geometry" below.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
} from 'react-native';

import { api } from '@/api';
import { useAuth } from '@/auth';
import { useActionMenu } from './ActionMenu';
import { Avatar } from './Avatar';
import { KebabIcon } from './icons';
import { ReactionBar } from './ReactionBar';
import { ReportModal } from './ReportModal';
import { SPINE_CENTRE } from './timeline';
import { invalidatePostComments, markPostCommentsSeen } from '@/postCache';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { Comment } from '@/types';
import { useAndroidBack } from '@/useAndroidBack';
import { formatRelativeTime } from '@/utils';

/*
 * ---------------------------------------------------------------------------
 * The geometry
 * ---------------------------------------------------------------------------
 *
 * **Every comment branches off its parent's line individually.** Siblings do not
 * share a spine of their own — that was the first attempt, and it read wrong:
 * with one line threaded through all the top-level comments, a second top-level
 * comment looked like a reply to the first rather than a reply to the post. Who
 * you are replying to is the single most important thing a comment thread has to
 * communicate, so the line has to say it.
 *
 * So a parent's line runs straight down past all of its children, and each child
 * reaches out to it with its own elbow, landing on that child's face. Reply depth
 * is then read off *which* vertical line you hang from, not off indentation
 * alone. Same shape as a file tree, for the same reason.
 *
 * Like the feed (`timeline.tsx`), each comment draws its own piece of that rather
 * than the thread drawing one long line behind everything — a `FlatList`-style
 * constraint that also happens to be what lets any node be collapsed. Each node
 * draws up to three things:
 *
 *   1. its **elbow** — out from the parent's line, curving down into its own
 *      face. Every comment has one, including top-level ones, whose parent line
 *      is the *post's* spine.
 *   2. the parent's line **carried past it**, when it isn't the last sibling, so
 *      the run reaches the sibling below. The last sibling omits this, which is
 *      what makes the line terminate on a face instead of trailing off.
 *   3. its own **stem**, from its face down to where its replies begin — only
 *      when it has replies showing.
 *
 * Those must butt exactly against each other, so **the gaps between comments are
 * padding *inside* a node, never a `gap` between them** — a flex gap is empty
 * space no segment covers, and it shows up as a break in the line.
 *
 * **Each comment carries its own step right as `paddingLeft`, and its replies
 * block adds nothing.** That's what keeps every line *inside* the node that
 * draws it: the parent's line lands at `COLUMN_CENTRE` from the node's left
 * edge, and the node's own line one step further in. The obvious alternative —
 * indenting the replies block and letting each child reach back out — puts the
 * elbow and the carried-past line at a negative offset, outside the node's
 * bounds. That renders on iOS, where overflow is visible by default, but is
 * exactly the kind of thing Android clips. Nothing here draws outside its own
 * box, so the question never arises.
 */

/** The bead column: avatar (24) plus its halo (3 each side), and no more. */
const BEAD = 24; // Avatar size="xs"
const BEAD_HALO = 3;
const COLUMN = BEAD + BEAD_HALO * 2;
const COLUMN_CENTRE = COLUMN / 2;
/** A bead's centre, measured from the top of its comment. */
const BEAD_CENTRE = BEAD_HALO + BEAD / 2;

const LINE = 2;

/**
 * How far a comment's line sits right of its parent's.
 *
 * It has to clear the beads: the parent's line now runs *past* its children, so
 * an indent much under half a bead width would have that line grazing the edge
 * of every face it passes. 22 leaves a comfortable 7pt.
 *
 * A full column per level would still march deep threads off the side of a
 * phone, so past the third level the step shrinks. Replies start collapsed, so
 * in practice you rarely see more than a couple of levels at once anyway.
 */
const INDENT = 22;
const DEEP_INDENT = 16;
const indentFor = (depth: number) => (depth < 3 ? INDENT : DEEP_INDENT);

/**
 * How far the whole thread sits right of the *post's* spine.
 *
 * A comment is a reply to the post, so it gets exactly what a reply gets: one
 * step right, hanging off the line above by its own elbow. The post, its
 * comments and their replies are then a single tree under one rule, rather than
 * a post with a separate comments widget bolted underneath.
 *
 * The thread owns this padding (rather than the screen) so that the post's spine
 * lands at `COLUMN_CENTRE` inside a top-level comment, exactly where any other
 * comment finds its parent's line. A top-level comment then needs no special
 * case: it takes its step right from the same `paddingLeft` as everyone else.
 */
const THREAD_INDENT = INDENT;
const THREAD_LEFT = SPINE_CENTRE - COLUMN_CENTRE;

/**
 * A vertical run of spine, centred on `left`, from `top` to the bottom of
 * whatever contains it.
 *
 * There's deliberately no way to make it stop short: a run that has to *end*
 * somewhere ends by not being rendered at all (the last sibling omits its
 * carried-past line). Keeping one mechanism means a line can't be terminated
 * two different ways in two different places.
 */
function ThreadLine({
  left,
  top = 0,
  testID,
}: {
  left: number;
  top?: number;
  testID?: string;
}) {
  return (
    <View
      testID={testID}
      pointerEvents="none"
      style={[styles.line, { left: left - LINE / 2, top }]}
    />
  );
}

/**
 * A comment's elbow: out from its parent's line at `from`, curving down to land
 * on its own face at `to`.
 *
 * Two borders and one rounded corner — no SVG dependency for what is, in the
 * end, a quarter circle. It's drawn before the bead, so the halo'd face paints
 * over the end of it and the line appears to run *into* the face rather than
 * under it.
 *
 * Its height is fixed at the bead's centre, which is what makes it land level
 * with the eye of the avatar whatever the comment's own height turns out to be.
 */
function Branch({
  from,
  to,
  testID,
}: {
  from: number;
  to: number;
  testID?: string;
}) {
  const width = to - from;
  return (
    <View
      testID={testID}
      pointerEvents="none"
      style={[
        styles.branch,
        {
          // Its left border sits on the line it leaves; its bottom border ends
          // on the face it joins.
          left: from - LINE / 2,
          width,
          // Never more curve than there is room for, in either direction —
          // a deep indent step is narrower than the drop.
          borderBottomLeftRadius: Math.min(10, width - LINE, BEAD_CENTRE - LINE),
        },
      ]}
    />
  );
}

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
        comments.map((comment, index) => (
          <CommentNode
            key={comment.id}
            comment={comment}
            postId={postId}
            expandIds={expandIds}
            highlightId={highlightCommentId}
            onHighlightLayout={onHighlightLayout}
            // The post's spine is the line these hang off — the thread's own
            // padding is set so that `SPINE_CENTRE` still points at it in here.
            indent={THREAD_INDENT}
            isLast={index === comments.length - 1}
          />
        ))
      ) : (
        <Text style={styles.empty}>No comments yet. Start the conversation.</Text>
      )}

      <View style={styles.threadComposer}>
        <CommentComposer postId={postId} placeholder="Write a comment…" />
      </View>
    </View>
  );
}

/** One comment: a bead on the spine, its reactions, and its branched replies. */
function CommentNode({
  comment,
  postId,
  expandIds,
  highlightId,
  onHighlightLayout,
  depth = 0,
  indent,
  isLast,
}: {
  comment: Comment;
  postId: number;
  expandIds: Set<number> | null;
  highlightId: number | null;
  onHighlightLayout?: (y: number) => void;
  depth?: number;
  /** How far our parent's line sits to our left — where our elbow reaches to. */
  indent: number;
  /** Last of its siblings, so the parent's line stops here rather than carrying
   *  on to a comment that isn't there. */
  isLast: boolean;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const replies = comment.replies ?? [];
  const [showReply, setShowReply] = useState(false);
  const [editing, setEditing] = useState(false);
  useAndroidBack(editing, () => setEditing(false));
  // Android back closes the reply box rather than the post — it's the only way
  // to abandon a reply without losing the post you were reading (#168).
  //
  // Per comment, so opening a second box while a first is still open leaves two
  // subscribed. React Native runs the most recently registered first, which
  // closes the one you just opened — the right answer, and the reason this
  // doesn't need a single owner for the whole tree.
  useAndroidBack(showReply, () => setShowReply(false));
  const [reporting, setReporting] = useState(false);
  // A tombstone (issue #128): the author deleted it, and it only survives
  // because replies hang off it. Everything below keys off this — it offers no
  // affordance at all except the toggle into those replies.
  const isDeleted = comment.deleted_at != null;
  // Reporting yourself is pointless, so the menu offers Edit/Delete instead on
  // your own comment. The backend refuses a self-report regardless.
  const isOwner = user != null && user.pk === comment.author.id;
  // One ⋯ for everybody, holding whichever pair applies — a tombstone gets none.
  const hasMenu = !isDeleted && user != null;

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteComment(comment.id),
    onSuccess: () => {
      // Refetch rather than splice: only the server knows whether the row went
      // or turned into a tombstone. The post's `comment_count` moved too, and
      // that rides the post payload wherever it's shown.
      invalidatePostComments(queryClient, postId);
    },
    onError: (err) => {
      Alert.alert(
        'Couldn’t delete',
        err instanceof Error ? err.message : 'Something went wrong.'
      );
    },
  });

  function confirmDelete() {
    Alert.alert(
      'Delete comment?',
      // What actually happens depends on whether anything hangs off it, so say
      // which. The count is the replies *you* can see, which is the honest
      // promise to make: a reply you can't see keeps the tombstone alive
      // server-side, but from where you're standing the comment simply goes.
      replies.length > 0
        ? 'This can’t be undone. The replies underneath will stay, with a note where your comment was.'
        : 'This can’t be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => deleteMutation.mutate(),
        },
      ]
    );
  }

  const { openMenu, menu } = useActionMenu();

  // **A comment's controls all live behind the ⋯**, exactly as a post's do and
  // exactly as the web's now do: your own offers Edit and Delete, someone else's
  // offers Report. Keeping Report inline while its two counterparts sat in a menu
  // made one control look like two different kinds of thing depending on whose
  // comment you were looking at — and it left a phone row of Reply + Report + a
  // replies toggle, indented once per level, wrapping onto a second line at
  // depth. Edit sits above Delete so the thumb heading for the safe action never
  // crosses the destructive one.
  const showMenu = () =>
    openMenu({
      title: 'Comment options',
      items: isOwner
        ? [
            {
              label: 'Edit comment',
              onPress: () => {
                setEditing(true);
                // **One write box per comment**, and on Android that's a
                // correctness rule, not tidiness: `useAndroidBack` is registered
                // per dismissible state and React Native runs the most recently
                // registered handler first, so with a reply box *and* an editor
                // open on the same node, which one hardware back closes is
                // decided by the order you happened to open them. Closing the
                // other makes the question unaskable — the shape #168 settled by
                // giving one screen one deliberate priority rather than racing
                // handlers.
                setShowReply(false);
              },
            },
            {
              label: 'Delete comment',
              destructive: true,
              onPress: confirmDelete,
            },
          ]
        : [{ label: 'Report comment', onPress: () => setReporting(true) }],
    });
  const [collapsed, setCollapsed] = useState(
    replies.length > 0 && !(expandIds?.has(comment.id) ?? false)
  );
  const isHighlighted = highlightId != null && comment.id === highlightId;

  /**
   * A *new* deep-link target reopens the branch it sits in (#177).
   *
   * `collapsed` is seeded once, at mount, from the ancestors of whatever was
   * deep-linked then. Since a tapped push reuses the post screen rather than
   * stacking a fresh one, a second notification for a different comment on the
   * same post changes `expandIds` without remounting anything — and a target
   * buried in a still-collapsed branch isn't rendered at all, so it can neither
   * be highlighted nor scrolled to.
   *
   * Keyed on the target, deliberately not on `expandIds`: that set is rebuilt
   * on every four-second poll, and reacting to its identity would spring open a
   * branch the reader had just collapsed by hand.
   *
   * Adjusted during render against the previous target rather than in an effect
   * — React's own pattern for state that follows a prop. An effect would re-run
   * the tree a second time with the branch still shut, and ESLint rejects
   * `setState` from one anyway.
   */
  const [lastHighlightId, setLastHighlightId] = useState(highlightId);
  if (highlightId !== lastHighlightId) {
    setLastHighlightId(highlightId);
    if (expandIds?.has(comment.id)) setCollapsed(false);
  }

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

  const showReplies = replies.length > 0 && !collapsed;
  const childIndent = indentFor(depth);

  const actionRow = (
    <View style={styles.actions}>
      {!isDeleted ? (
        <Pressable
          onPress={() => {
            setShowReply((open) => !open);
            // Engaging with a sub-thread should reveal it — for context, and so
            // the reply you're about to write lands somewhere visible.
            setCollapsed(false);
            // One write box per comment — see the ⋯ menu's Edit.
            setEditing(false);
          }}
          accessibilityRole="button"
          hitSlop={6}
        >
          <Text style={styles.action}>Reply</Text>
        </Pressable>
      ) : null}

      {hasMenu ? (
        <Pressable
          onPress={showMenu}
          accessibilityRole="button"
          accessibilityLabel="Comment options"
          hitSlop={8}
        >
          <KebabIcon color={colors.inkFaint} />
        </Pressable>
      ) : null}

      {/* Kept even on a tombstone — the replies underneath are the only reason
          it's still here, so hiding the way in would strand them. */}
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
  );

  // Reply and the replies toggle are handed to `ReactionBar` rather than
  // rendered as a row of their own — exactly as `PostCard` hands over its
  // comments link. On a comment with no reactions the reaction row is just the
  // add button, so these share that line instead of spending a second one; once
  // there are chips to read they drop below. Only `ReactionBar` knows which it
  // is, because it owns the reaction state after a tap.
  //
  // A tombstone skips it entirely: its reactions were cleared with the delete
  // and it can't take new ones, so an add button there would offer a reaction to
  // nothing.
  const actions = isDeleted ? (
    actionRow
  ) : (
    <ReactionBar
      commentId={comment.id}
      reactions={comment.reactions}
      trailing={actionRow}
    />
  );

  return (
    <View
      testID={`comment-${comment.id}`}
      onLayout={onHighlightLayout ? handleLayout : undefined}
      // Our step right of the line we hang from. Our own content starts here;
      // our parent's line stays at `COLUMN_CENTRE`, inside our bounds.
      style={{ paddingLeft: indent }}
    >
      {/* (1) Out from the parent's line and down onto our own face. Absolute
          children measure from the padding box, so these two are in the node's
          own coordinates — where the parent's line is `COLUMN_CENTRE` and ours
          is one step further in. Inside `row` below, the padding is already
          spent, so our line is `COLUMN_CENTRE` again there. */}
      <Branch
        from={COLUMN_CENTRE}
        to={indent + COLUMN_CENTRE}
        testID={`branch-${comment.id}`}
      />

      {/* (2) The parent's line carried past us — the *whole* node, replies and
          all, so it reaches the sibling below rather than stopping at our text.
          Omitted when we're last: that's what ends the run on a face. */}
      {!isLast ? (
        <ThreadLine left={COLUMN_CENTRE} testID={`past-${comment.id}`} />
      ) : null}

      <View style={styles.row}>
        {/* (3) Our own stem, from our face down to where our replies start. It
            spans the row only — the replies block below picks it up from there.
            Nothing to hold up if there are no replies showing. */}
        {showReplies ? (
          <ThreadLine
            left={COLUMN_CENTRE}
            top={BEAD_CENTRE}
            testID={`stem-${comment.id}`}
          />
        ) : null}

        <View style={styles.beadColumn}>
          <View style={styles.bead}>
            <Avatar user={comment.author} size="xs" />
          </View>
        </View>

        <View style={styles.body}>
          <View style={[styles.content, isHighlighted && styles.highlighted]}>
            <View style={styles.header}>
              <Text style={styles.author} numberOfLines={1}>
                {comment.author.display_name}
              </Text>
              <Text style={styles.time}>
                {formatRelativeTime(comment.created_at)}
              </Text>
              {/* The transparency floor, same as a post's (`PostCard`): the
                  marker alone, there being no hover on a phone to carry the
                  exact time. Silently changing something others have already
                  read is the trust problem it exists to close. */}
              {comment.edited_at && !isDeleted ? (
                <Text style={styles.edited}>· edited</Text>
              ) : null}
            </View>

            {isDeleted ? (
              <Text style={[styles.text, styles.deleted]}>Comment deleted</Text>
            ) : editing ? (
              <CommentEditor
                commentId={comment.id}
                postId={postId}
                initialText={comment.text}
                onDone={() => setEditing(false)}
              />
            ) : (
              <Text style={styles.text}>{comment.text}</Text>
            )}

            {/* Reply and the replies toggle are handed to `ReactionBar` rather
                than rendered as a row of their own — exactly as `PostCard`
                hands over its comments link. On a comment with no reactions
                the reaction row is just the add button, so these share that
                line instead of spending a second one; once there are chips to
                read they drop below. Only `ReactionBar` knows which it is,
                because it owns the reaction state after a tap. */}
            {actions}

            {showReply && !isDeleted ? (
              <CommentComposer
                postId={postId}
                parentId={comment.id}
                autoFocus
                placeholder={`Reply to ${comment.author.display_name}…`}
                onDone={() => setShowReply(false)}
              />
            ) : null}

            {menu}

            {reporting ? (
              <ReportModal
                commentId={comment.id}
                onClose={() => setReporting(false)}
              />
            ) : null}
          </View>
        </View>
      </View>

      {showReplies ? (
        <View
          testID={`replies-${comment.id}`}
          // **No style at all**, deliberately. The step right is the replies'
          // own `paddingLeft`, not an indent applied here — that's what keeps
          // their elbows inside their own bounds. And no top padding: our stem
          // ends at this block's top edge and the first reply's elbow starts
          // there, so anything between them is a break in the line. The air
          // above comes from our own `body` padding.
          onLayout={
            onHighlightLayout
              ? (event) => {
                  repliesY.current = event.nativeEvent.layout.y;
                }
              : undefined
          }
        >
          {/* No line of its own: our stem hands off to the replies' elbows,
              each of which draws the run past itself. */}
          {replies.map((reply, index) => (
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
              indent={childIndent}
              isLast={index === replies.length - 1}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * Edit your own comment in place (issue #128).
 *
 * **Inline, not a modal sheet — deliberately the opposite of `PostEditModal`.**
 * That sheet exists because a post card lives in a virtualised `FlatList`, where
 * a row scrolled out of the window unmounts and takes a half-typed edit with it.
 * A comment thread has neither problem: it renders inside the post screen's
 * `KeyboardAwareScroll`, nothing unmounts, and the reply composer is already an
 * inline `TextInput` in exactly this spot. A sheet here would be a second
 * pattern for the same job, one step away from the first.
 *
 * Android back closes it (`useAndroidBack` in the node above), so an edit can be
 * abandoned without leaving the post — the rule the reply box already follows.
 */
function CommentEditor({
  commentId,
  postId,
  initialText,
  onDone,
}: {
  commentId: number;
  postId: number;
  initialText: string;
  onDone: () => void;
}) {
  const [text, setText] = useState(initialText);
  const queryClient = useQueryClient();

  const { mutate, isPending, error } = useMutation({
    mutationFn: (value: string) => api.updateComment(commentId, value),
    onSuccess: () => {
      // Only the thread changes — an edit can't move a comment count, so the
      // post lists are left alone (unlike delete).
      queryClient.invalidateQueries({ queryKey: ['comments', postId] });
      onDone();
    },
  });

  const trimmed = text.trim();
  // Emptying a comment is a delete, and delete is its own action — the server
  // says the same, so a disabled Save can never 400.
  const canSave = trimmed.length > 0 && !isPending;

  function save() {
    // Read the same `canSave` the button's `disabled` reads, so the two can't
    // disagree — the house rule from #164 (the message composer) and #146
    // (`PostEditModal`). The button already blocks this; a gate that lives only
    // on a prop is one refactor away from not existing.
    if (!canSave) return;
    // An unchanged Save is a plain close: the server already refuses to stamp
    // `edited_at` on a no-op, so nothing visible differs, but on a phone this
    // saves a round-trip and a refetch. Same rule the post and message editors
    // follow.
    if (trimmed === initialText.trim()) {
      onDone();
      return;
    }
    mutate(trimmed);
  }

  return (
    <View style={styles.composer}>
      <TextInput
        style={styles.input}
        value={text}
        onChangeText={setText}
        accessibilityLabel="Edit comment text"
        multiline
        autoFocus
        editable={!isPending}
      />

      <Text style={styles.note}>Edited comments are marked “edited”.</Text>

      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error instanceof Error ? error.message : 'Couldn’t save. Try again.'}
        </Text>
      ) : null}

      <View style={styles.composerActions}>
        <Pressable onPress={onDone} accessibilityRole="button" hitSlop={6}>
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
        <Pressable
          onPress={save}
          disabled={!canSave}
          style={({ pressed }) => [
            styles.submit,
            pressed && styles.submitPressed,
            !canSave && styles.submitDisabled,
          ]}
          accessibilityRole="button"
          accessibilityLabel="Save comment"
        >
          <Text style={styles.submitText}>
            {isPending ? 'Saving…' : 'Save'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * The write box for a comment (`parentId` null) or a reply.
 *
 * On success it invalidates the tree so the new node appears in place, rather
 * than trying to splice it in at the right depth on the client — and, through
 * the same helper the delete path uses, the post lists carrying the now-stale
 * `comment_count` (#273).
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
      // The tree, plus the post's `comment_count` on every surface showing it —
      // the same set the delete path invalidates, from the same helper.
      invalidatePostComments(queryClient, postId);
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
  // The one step right of the post's spine that every comment hangs off; the
  // elbows are positioned against `SPINE_CENTRE` inside this padding box.
  //
  // Deliberately nothing else. No `gap` and no `paddingTop`: both would be
  // stretches of thread that no segment covers, so both show up as breaks in
  // the line — above the first comment, and between every pair after it. The
  // spacing comes from inside each comment (`body`) and, above the first, from
  // the post card's own bottom padding.
  thread: { paddingLeft: THREAD_LEFT },
  // These two aren't comments, so they don't carry a comment's `paddingLeft` —
  // they'd otherwise sit flush against the screen edge, a step left of every
  // comment above them. Line them up with where a comment's own box starts.
  threadComposer: { marginTop: spacing.sm, marginLeft: THREAD_INDENT },
  loading: { marginVertical: spacing.lg },

  line: {
    position: 'absolute',
    width: LINE,
    backgroundColor: colors.spine,
    // Runs to the bottom of whatever contains it. **Without this the view has
    // no height and the line silently vanishes** — an absolutely positioned
    // View with only `top` set measures zero, so every vertical disappeared
    // while the elbows carried on rendering and the thread still *looked*
    // plausible. `the lines` tests assert this style is present for that
    // reason: presence of the element is not presence of a line.
    bottom: 0,
  },
  branch: {
    position: 'absolute',
    top: 0,
    // Down to the face's centre line, and no further.
    height: BEAD_CENTRE,
    borderLeftWidth: LINE,
    borderBottomWidth: LINE,
    borderLeftColor: colors.spine,
    borderBottomColor: colors.spine,
  },

  row: { flexDirection: 'row' },
  beadColumn: { width: COLUMN, alignItems: 'center' },
  bead: {
    // A surface-coloured halo lifts the face off the line behind it.
    borderWidth: BEAD_HALO,
    borderColor: colors.surface,
    borderRadius: radius.pill,
  },
  body: {
    flex: 1,
    paddingLeft: spacing.sm,
    // The halo sits outside the avatar, so the text column drops by that much
    // to sit level with the face rather than with the halo's edge.
    paddingTop: BEAD_HALO,
    // The breathing room between comments lives here, inside the node, so the
    // spine segment above covers it.
    paddingBottom: spacing.lg,
  },
  // No `gap`: `ReactionBar` and the composer bring their own top margins, and a
  // gap on top of those spaced a comment's reaction row further from its text
  // than a post's is from its own — same component, two different looks.
  content: {},
  highlighted: {
    // Both sides, cancelling the padding below, so a highlighted comment's text
    // column is exactly as wide as its neighbours'. With the negative margin on
    // one side only, a comment reached from a notification wrapped differently
    // from the same comment a moment earlier in the feed.
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
    // An explicit line box of exactly the bead's height, so the name's centre
    // lands on the face's centre without any nudging (as in PostCard).
    lineHeight: BEAD,
    flexShrink: 1,
  },
  time: { fontSize: 11, color: colors.inkFaint, lineHeight: BEAD },
  edited: { fontSize: 11, color: colors.inkFaint, lineHeight: BEAD },
  // Its own top margin now `content` has no gap — matching `PostCard`, where
  // the post's text sits the same distance under its header.
  text: { fontSize: 15, color: colors.ink, lineHeight: 21, marginTop: spacing.xs },
  // A tombstone reads as an absence, not as something someone wrote.
  deleted: { color: colors.inkFaint, fontStyle: 'italic' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  action: { fontSize: fontSize.sm, color: colors.inkFaint, fontWeight: '600' },
  toggle: { fontSize: fontSize.sm, color: colors.accentDeep, fontWeight: '600' },
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
  // The edit sheet's disclosure, worded and styled as `PostEditModal`'s is —
  // you're told the marker is coming *before* you save, not only after.
  note: { fontSize: fontSize.sm, color: colors.inkFaint },
  submit: {
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
  },
  submitPressed: { backgroundColor: colors.accentDeep },
  submitDisabled: { opacity: 0.4 },
  submitText: { color: colors.raised, fontWeight: '600', fontSize: fontSize.sm },
  empty: {
    fontSize: fontSize.sm,
    color: colors.inkFaint,
    marginLeft: THREAD_INDENT, // see `threadComposer`
  },
  error: { fontSize: fontSize.sm, color: colors.danger },
});
