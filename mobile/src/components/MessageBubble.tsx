/**
 * One message row in a thread. Ported from the web's `MessageBubble`, restyled
 * native and with the touch affordances a phone needs.
 *
 * Layout mirrors the web: your messages align right with the filled accent,
 * everyone else's align left in a raised bubble. A soft-deleted message leaves a
 * muted "Message deleted" tombstone in its original spot, so the thread never
 * silently reshuffles.
 *
 * **Group sender attribution.** In a *group* thread an incoming message shows its
 * sender's avatar + name on a line above the bubble — without it, three people's
 * left-aligned bubbles are indistinguishable. Only the *first* bubble of a
 * consecutive run from one sender is labelled (`showSender`, decided by the
 * caller), so a burst reads as one block. Three deliberate exclusions, all
 * handled by the caller passing `showSender={false}`: 1:1 threads (only one
 * person it could be), your own messages (right-alignment already says they're
 * yours), and a run's later bubbles.
 *
 * **Long-press opens the action menu** (Phase 9b M1) — Copy/Edit/Delete on your
 * own, Copy/Report on someone else's, plus the quick-reaction row. This replaced
 * a long-press that went straight to a delete confirm: a gesture that only ever
 * deletes is a trap, and there was nowhere to put edit. The bubble measures its
 * own screen rect and hands it up, because the menu anchors itself under the
 * bubble you actually pressed (see `MessageActionMenu`). A deleted message's
 * tombstone has no menu — there's nothing left to act on.
 *
 * **Reaction pills** (Phase 9b M2) hang off the bubble's lower edge on its near
 * side, and tapping one opens "who reacted" — see `ReactionPills` for why that's
 * the only gesture on them. They sit *outside* `BubbleBody` on purpose: the menu
 * re-renders that component at the bubble's measured rect, and a pill overlapping
 * its edge with a negative margin would both alter the measurement and duplicate
 * the pills over the real ones.
 *
 * **Replies** (Phase 9b M3) add two things and one gesture. A reply carries a
 * collapsed quote *inside* the bubble (`QuotedMessage`, and so inside
 * `BubbleBody`, so the menu's preview shows it), and a message with replies
 * grows a "3 replies" branch beneath it that opens the focused thread view.
 *
 * **One gesture per target**, the rule M2 settled and the reason there are three
 * distinct affordances here rather than one overloaded bubble: **swipe right** =
 * reply, **long-press** = the action menu, **tap the branch** = open the thread.
 * The bubble's own tap does nothing, and should stay that way — a target this
 * size doing different things by press duration is where a mis-timed press does
 * the wrong thing.
 */

import { useMemo, useRef, useState } from 'react';
import * as Haptics from 'expo-haptics';
import {
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { Avatar } from './Avatar';
import type { BubbleAnchor } from './MessageActionMenu';
import { measureInWindow } from '@/measure';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { Message, Reaction } from '@/types';
import { formatRelativeTime } from '@/utils';

/** How far right you must drag before letting go fires a reply. */
const SWIPE_TRIGGER = 56;
/** The bubble stops moving here, so the gesture never turns into a drag. */
const SWIPE_MAX = 76;

/**
 * Should a drag of `(dx, dy)` become a reply swipe?
 *
 * Exported and pure so the *decision* is testable under Node. `PanResponder`
 * derives its gesture state from native touch history, which a Jest environment
 * has none of — so the wiring is a device check (as the emoji-picker handover
 * already is), but the rule that decides when a swipe counts is not, and it's
 * the part with the bugs in it.
 *
 * Rightward only, and only when the drag is decidedly more horizontal than
 * vertical, so the thread's own scrolling always wins a close call. Left is left
 * free deliberately — that's where a future peek or delete would go, and a
 * gesture that does the same thing both ways can't be extended.
 */
export function shouldStartReplySwipe(dx: number, dy: number, enabled: boolean) {
  return enabled && dx > 8 && Math.abs(dx) > Math.abs(dy) * 1.5;
}

/** Did a released drag travel far enough to count as a reply? */
export function didTriggerReply(dx: number) {
  return dx >= SWIPE_TRIGGER;
}

/**
 * The bubble itself — background, text, timestamp — with no positioning of its
 * own. Split out from `MessageBubble` so the action menu can redraw the pressed
 * bubble at its measured position and get *the real thing*, not a lookalike that
 * drifts the first time this styling changes. It deliberately carries no
 * `maxWidth`: the wrapper owns that, so a copy rendered into a fixed-width slot
 * fills it exactly.
 */
export function BubbleBody({
  message,
  mine,
  quoted,
  onQuotePress,
}: {
  message: Message;
  mine: boolean;
  /** The message this one replies to, if the caller could resolve it. */
  quoted?: Message;
  /**
   * Open the thread this reply belongs to. Omitted by the action menu's preview
   * — a preview is a picture of the bubble, not a working copy of it.
   */
  onQuotePress?: () => void;
}) {
  return (
    <View style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
      {/* Inside the bubble, above the text — the standard treatment, and it
          means the action menu's preview (which re-renders this component)
          shows the quote too, so you can see exactly what you're acting on. */}
      {message.reply_to ? (
        <QuotedMessage
          reference={message.reply_to}
          quoted={quoted}
          mine={mine}
          onPress={onQuotePress}
        />
      ) : null}
      <Text style={[styles.text, mine ? styles.mineText : styles.theirsText]}>
        {message.text}
      </Text>
      <Text style={[styles.time, mine ? styles.mineTime : styles.theirsTime]}>
        {formatRelativeTime(message.created_at)}
        {/* An edit is disclosed, never silent: a thread is a shared record, and
            quietly changing what someone already read would make it worthless
            as one. */}
        {message.is_edited ? ' · Edited' : ''}
      </Text>
    </View>
  );
}

/**
 * The emoji pills under a bubble.
 *
 * **One gesture: tap opens "who reacted".** The pill is a *display* of what the
 * thread said, so a tap goes to the detail of it rather than silently changing
 * it — and a tiny target that both toggles and, on a longer press, does something
 * else is exactly where a mis-timed press does the wrong thing.
 *
 * That leaves two unambiguous places to *change* your own reaction, which is one
 * more than the pill needed to be: the long-press menu's emoji row (tapping one
 * you've used takes it off) and the sheet this opens, where your own row reads
 * "Tap to remove". This deliberately differs from the feed's chips, which do
 * toggle on tap — a post has no long-press menu to carry the alternative.
 */
function ReactionPills({
  reactions,
  mine,
  onShowReactors,
}: {
  reactions: Reaction[];
  mine: boolean;
  onShowReactors?: () => void;
}) {
  return (
    <View style={[styles.pillRow, mine ? styles.alignEnd : styles.alignStart]}>
      {reactions.map((reaction) => (
        <Pressable
          key={reaction.emoji}
          onPress={onShowReactors}
          hitSlop={4}
          accessibilityRole="button"
          accessibilityState={{ selected: reaction.reacted }}
          accessibilityLabel={`${reaction.emoji}, ${reaction.count}${
            reaction.reacted ? ', including you' : ''
          } — see who reacted`}
          style={({ pressed }) => [
            styles.pill,
            reaction.reacted && styles.pillMine,
            pressed && styles.pillPressed,
          ]}
        >
          <Text style={styles.pillEmoji}>{reaction.emoji}</Text>
          {/* A lone reaction needs no "1" beside it — the emoji is the whole
              message. The count only earns its space once it's ambiguous. */}
          {reaction.count > 1 ? (
            <Text style={styles.pillCount}>{reaction.count}</Text>
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}

/**
 * The collapsed quote above a reply (Phase 9b M3) — who was answered, and a line
 * of what they said.
 *
 * **The text is resolved by the caller, never sent with the reply.** A reply's
 * payload carries only `{ id, sender }`; the body comes from a message the
 * client already holds, or from the focused thread's own fetch, both of which go
 * through the server's interval clipping. That's what stops a quote becoming a
 * window into history the viewer was clipped out of. When it can't be resolved,
 * "Original message unavailable" is a *true* statement about a message the
 * viewer isn't entitled to — not a loading state.
 */
function QuotedMessage({
  reference,
  quoted,
  mine,
  onPress,
}: {
  reference: NonNullable<Message['reply_to']>;
  quoted?: Message;
  mine: boolean;
  /**
   * Open the thread. **The quote is the way in for a reply**, the way the reply
   * count is for a root — and it's needed, not just convenient: when the root is
   * one the viewer was clipped out of, its replies stand alone in the transcript
   * with no root to carry a count, so without this the strand would be
   * unreachable for exactly the person whose view of it is already partial.
   */
  onPress?: () => void;
}) {
  const body = quoted?.is_deleted
    ? 'Message deleted'
    : (quoted?.text ?? 'Original message unavailable');
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={
        onPress
          ? `In reply to ${reference.sender.display_name} — open thread`
          : undefined
      }
      style={[styles.quote, mine ? styles.quoteMine : styles.quoteTheirs]}
    >
      <Text
        style={[
          styles.quoteName,
          mine ? styles.quoteNameMine : styles.quoteNameTheirs,
        ]}
        numberOfLines={1}
      >
        {reference.sender.display_name}
      </Text>
      <Text
        style={[
          styles.quoteText,
          mine ? styles.quoteTextMine : styles.quoteTextTheirs,
          !quoted && styles.quoteMissing,
        ]}
        numberOfLines={2}
      >
        {body}
      </Text>
    </Pressable>
  );
}

export function MessageBubble({
  message,
  mine,
  showSender,
  quoted,
  onLongPress,
  onShowReactors,
  onReply,
  onOpenThread,
}: {
  message: Message;
  mine: boolean;
  showSender: boolean;
  /** The message this one replies to, if the caller could resolve it. */
  quoted?: Message;
  /**
   * Opens the action menu, anchored to this bubble's rect on screen. Omitted
   * inside the focused thread view, which is deliberately menu-less — see
   * `MessageThreadView`.
   */
  onLongPress?: (anchor: BubbleAnchor) => void;
  /** Open "who reacted" for this message — what tapping a pill does. */
  onShowReactors?: () => void;
  /** Start a reply to this message — what a right-swipe does. Omitted in a
   *  thread you can no longer send to, which also disables the gesture. */
  onReply?: () => void;
  /** Open the focused thread view — what the reply-count affordance does. */
  onOpenThread?: () => void;
}) {
  const bubbleRef = useRef<View>(null);
  const reactions = message.reactions ?? [];
  const replyCount = message.reply_count ?? 0;

  /**
   * Swipe right to reply.
   *
   * **`PanResponder` + RN's `Animated`, not gesture-handler + Reanimated**, even
   * though both are dependencies. Reanimated's worklet runtime can't be loaded
   * under Jest, so building the gesture on it would mean mocking away the
   * component under test — the same reasoning that kept `MessageActionMenu`'s
   * animation on `Animated`. A horizontal drag with a spring back is exactly
   * what `PanResponder` is for, and nothing about the feel is lost.
   *
   * The responder claims the touch **only for a rightward drag that's more
   * horizontal than vertical**, so the FlatList keeps every scroll. It's also
   * strictly one-directional: dragging left does nothing, because a left-swipe
   * is where a future delete or a peek at timestamps would live and a gesture
   * that does one thing in both directions can't be extended.
   */
  // `useState` with an initialiser rather than a ref: the value is read during
  // render (it drives a style), and a ref read in render is exactly what React
  // tells you not to do — the same call `MessageActionMenu` makes for its own
  // Animated.Value.
  const [dragX] = useState(() => new Animated.Value(0));

  // Rebuilt whenever `onReply` changes identity, which it does on every render
  // of the thread screen. That's deliberate and it isn't wasteful: `create` only
  // assembles a config object (the gesture state itself lives in RN's responder
  // system), and the alternative — build it once, reach for the latest handler
  // through a ref — would close over a stale `startReplying` and consult a stale
  // idea of what the composer was doing.
  const pan = useMemo(
    () => {
      const springBack = () => {
        Animated.spring(dragX, {
          toValue: 0,
          useNativeDriver: true,
          bounciness: 0,
        }).start();
      };
      return PanResponder.create({
        onMoveShouldSetPanResponder: (_e, { dx, dy }) =>
          shouldStartReplySwipe(dx, dy, !!onReply),
        onPanResponderMove: (_e, { dx }) => {
          // Clamped, so it reads as an affordance nudging open rather than the
          // bubble being dragged around the screen.
          dragX.setValue(Math.min(Math.max(dx, 0), SWIPE_MAX));
        },
        onPanResponderRelease: (_e, { dx }) => {
          if (didTriggerReply(dx)) {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(
              () => {}
            );
            onReply?.();
          }
          springBack();
        },
        // A cancelled gesture (a call arriving, a modal opening) must put the
        // bubble back too, or it stays parked mid-swipe.
        onPanResponderTerminate: springBack,
      });
    },
    [dragX, onReply]
  );

  function handleLongPress() {
    // A light tap under the finger is most of what makes the gesture feel
    // deliberate rather than accidental. Fire and forget — a phone without a
    // taptic engine simply resolves it.
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    // Measure first, open second: the menu positions itself from this rect, so
    // opening before it lands would put the menu somewhere and then move it.
    if (!onLongPress) return;
    measureInWindow(bubbleRef.current, onLongPress);
  }

  return (
    <View style={styles.row}>
      {showSender && (
        <View style={styles.senderLine}>
          <Avatar user={message.sender} size="xs" />
          <Text style={styles.senderName} numberOfLines={1}>
            {message.sender.display_name}
          </Text>
        </View>
      )}

      <Animated.View
        style={[
          styles.bubbleRow,
          mine ? styles.alignEnd : styles.alignStart,
          { transform: [{ translateX: dragX }] },
        ]}
        {...pan.panHandlers}
      >
        {message.is_deleted ? (
          <View style={styles.tombstone}>
            <Text style={styles.tombstoneText}>Message deleted</Text>
          </View>
        ) : (
          <Pressable
            ref={bubbleRef}
            onLongPress={onLongPress ? handleLongPress : undefined}
            delayLongPress={350}
            accessibilityRole="text"
            // The label lets the menu be opened by assistive tech and driven in
            // tests, since a long-press isn't otherwise discoverable.
            accessibilityLabel={
              mine
                ? `Your message: ${message.text}`
                : `Message from ${message.sender.display_name}: ${message.text}`
            }
            accessibilityHint="Press and hold for message actions"
            style={styles.bubbleWrap}
          >
            <BubbleBody
              message={message}
              mine={mine}
              quoted={quoted}
              onQuotePress={onOpenThread}
            />
          </Pressable>
        )}
      </Animated.View>

      {/* Rendered on a tombstone too. A reaction someone left is a thing that
          happened, and silently dropping it when the message is deleted would
          make it look as though they never did. */}
      {reactions.length > 0 ? (
        <ReactionPills
          reactions={reactions}
          mine={mine}
          onShowReactors={onShowReactors}
        />
      ) : null}

      {/* The way into the focused thread, and the *only* tap that opens it —
          the bubble's own tap stays free. Drawn as a branch off the bubble, the
          same living line the feed's comment threads use, so a thread reads as
          growing out of the message rather than as a button stuck under it. */}
      {replyCount > 0 && onOpenThread ? (
        <View style={mine ? styles.alignEnd : styles.alignStart}>
          <Pressable
            onPress={onOpenThread}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={`${replyCount} ${
              replyCount === 1 ? 'reply' : 'replies'
            } — open thread`}
            style={({ pressed }) => [styles.threadLink, pressed && styles.pressed]}
          >
            <View style={styles.branch} />
            <Text style={styles.threadLinkText}>
              {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { marginBottom: spacing.sm },
  senderLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
    marginBottom: spacing.xs,
  },
  senderName: {
    flexShrink: 1,
    fontSize: fontSize.sm - 1,
    fontWeight: '500',
    color: colors.inkSoft,
  },
  bubbleRow: { flexDirection: 'row' },
  alignEnd: { justifyContent: 'flex-end' },
  alignStart: { justifyContent: 'flex-start' },
  bubbleWrap: { maxWidth: '80%' },
  bubble: {
    paddingHorizontal: spacing.md - 2,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
  },
  mine: { backgroundColor: colors.accent },
  theirs: {
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.line,
  },
  text: { fontSize: fontSize.base - 1, lineHeight: 21 },
  mineText: { color: '#ffffff' },
  theirsText: { color: colors.ink },
  time: { marginTop: 2, fontSize: 11 },
  mineTime: { color: 'rgba(255,255,255,0.7)' },
  theirsTime: { color: colors.inkFaint },
  // Pulled up over the bubble's lower edge, the standard chat treatment: the
  // pill reads as attached to that message rather than as a row of its own.
  pillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: -spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: spacing.sm - 2,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  pillMine: { backgroundColor: colors.accentTint, borderColor: colors.accent },
  pillPressed: { opacity: 0.6 },
  // The quote sits inset at the top of the bubble behind a vertical rule — the
  // living line again, this time marking "these words are someone else's".
  quote: {
    marginBottom: spacing.xs + 2,
    paddingLeft: spacing.sm,
    borderLeftWidth: 2,
  },
  // Tinted against whichever bubble it's in, so it stays legible on the accent
  // fill as well as on the raised surface.
  quoteMine: {
    borderLeftColor: 'rgba(255,255,255,0.6)',
  },
  quoteTheirs: { borderLeftColor: colors.accent },
  quoteName: { fontSize: fontSize.sm - 1, fontWeight: '700' },
  quoteText: { fontSize: fontSize.sm, lineHeight: 18 },
  quoteMissing: { fontStyle: 'italic' },
  quoteNameMine: { color: 'rgba(255,255,255,0.9)' },
  quoteTextMine: { color: 'rgba(255,255,255,0.75)' },
  quoteNameTheirs: { color: colors.accentDeep },
  quoteTextTheirs: { color: colors.inkSoft },
  // The branch into a reply thread: a short stub of line, then the count.
  threadLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  branch: {
    width: 14,
    height: 1,
    backgroundColor: colors.lineStrong,
  },
  threadLinkText: {
    fontSize: fontSize.sm - 1,
    fontWeight: '600',
    color: colors.accent,
  },
  pressed: { opacity: 0.6 },
  pillEmoji: { fontSize: 13 },
  pillCount: { fontSize: fontSize.sm - 1, color: colors.inkSoft },
  tombstone: {
    maxWidth: '80%',
    paddingHorizontal: spacing.md - 2,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
    backgroundColor: 'rgba(28,26,22,0.03)',
  },
  tombstoneText: {
    fontSize: fontSize.base - 1,
    fontStyle: 'italic',
    color: colors.inkFaint,
  },
});
