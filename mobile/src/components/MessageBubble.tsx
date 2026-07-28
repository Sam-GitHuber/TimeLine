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
 * **Send state** (Phase 9b M4) shows on your own bubbles: a clock while the
 * message is still in the outbox, one tick once the server has it, two accented
 * ticks once everyone it was for has read it. A send that *failed* keeps its
 * place, dimmed, with Retry and Discard beneath — text someone typed is never
 * thrown away on their behalf. What "read" means lives in `src/readReceipts.ts`,
 * not here; this component only draws what it's handed.
 *
 * **Replies** (Phase 9b M3) add two things. A reply carries a collapsed quote
 * *inside* the bubble (`QuotedMessage`, and so inside `BubbleBody`, so the menu's
 * preview shows it), and a message with replies grows a "3 replies" branch
 * beneath it that opens the focused thread view.
 *
 * **Run grouping and chat typography** (Phase 9b M5). A bubble knows whether it
 * ends a run (`endsRun`, decided by the caller, which is the only place that can
 * see the neighbours) and that drives three things at once: the timestamp, the
 * squared-off tail corner, and the tighter spacing that makes a burst read as
 * one block. The time itself is now a **clock** ("14:32") rather than "5m ago" —
 * the day separator above carries the date, so what a bubble has to answer is
 * when in the day. URLs and email addresses are **tappable**, and a message that
 * is nothing but one to three emoji drops its bubble and is drawn large.
 *
 * **One gesture per target**, the rule M2 settled: **long-press** = the action
 * menu (Reply included), **tap the branch** = open the thread. The bubble's own
 * tap does nothing, and should stay that way — a target this size doing
 * different things by press duration is where a mis-timed press does the wrong
 * thing. A tappable *link* inside the text is the one exception, and it isn't
 * really one: it's a smaller target with its own affordance, and long-pressing
 * over it still opens the menu.
 *
 * **There is deliberately no swipe-to-reply.** M3 shipped one and it was taken
 * out after a day of real use: a rightward drag starting on a bubble is also the
 * navigator's back gesture, so the swipe raced the screen it was swiping on and
 * usually lost — you'd land back on the conversation list with no reply started.
 * That's a clash a threshold can't tune away, because both gestures are
 * legitimately claiming the same drag; the loser is whichever responder happens
 * to win the touch. Long-press → Reply is one unambiguous route and it never
 * fights the navigator. If a swipe ever comes back it needs the screen's own
 * back gesture disabled while a bubble owns the touch, which is a bigger change
 * than the affordance is worth.
 */

import { useRef } from 'react';
import * as Haptics from 'expo-haptics';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from './Avatar';
import { SendStateIcon } from './icons';
import type { BubbleAnchor } from './MessageActionMenu';
import { measureInWindow } from '@/measure';
import { isEmojiOnly, linkify } from '@/messageText';
import type { SendState } from '@/readReceipts';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { Message, Reaction } from '@/types';
import { formatMessageTime } from '@/utils';

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
  status,
  endsRun = true,
  onQuotePress,
}: {
  message: Message;
  mine: boolean;
  /** The message this one replies to, if the caller could resolve it. */
  quoted?: Message;
  /**
   * The send state to show beside the timestamp (Phase 9b M4). Only ever passed
   * for your own messages — a tick on someone else's would be meaningless — and
   * omitted entirely when receipts can't be shown, so the row of permanent
   * single ticks that would otherwise imply "nobody reads these" never appears.
   */
  status?: SendState;
  /**
   * Last bubble of a run (Phase 9b M5) — it carries the timestamp and the
   * squared-off tail corner. Defaults to true so a bubble drawn on its own (the
   * action menu's preview, the focused thread view) looks complete.
   */
  endsRun?: boolean;
  /**
   * Open the thread this reply belongs to. Omitted by the action menu's preview
   * — a preview is a picture of the bubble, not a working copy of it.
   */
  onQuotePress?: () => void;
}) {
  /**
   * The meta line goes on the run's last bubble only — that's the whole point of
   * grouping, and a timestamp repeated down five bubbles sent in one minute is
   * noise standing where the next message should be.
   *
   * **Two exceptions, and both are load-bearing rather than tidy-ups.** An
   * "Edited" marker is a disclosure: `messaging.md` calls it the thing that
   * makes editing safe at all, so it can't be suppressed by where a bubble
   * happens to sit in a run. And an unsent message has to show its clock or its
   * failure wherever it lands, or two queued messages would leave the first
   * looking sent.
   */
  const unsent = status === 'sending' || status === 'failed';
  const showMeta = endsRun || message.is_edited || unsent;
  /**
   * One to three emoji and nothing else: drop the bubble and draw it large, the
   * treatment every mainstream messenger gives it. A few lines of code and one
   * of the most-noticed details in a chat.
   *
   * Not for a reply, which has a quote block that needs a bubble to sit in, and
   * not for a tombstone, which has no text of its own.
   */
  const large = !message.reply_to && !message.is_deleted && isEmojiOnly(message.text);

  return (
    <View
      style={[
        large ? styles.bare : styles.bubble,
        !large && (mine ? styles.mine : styles.theirs),
        // The tail: the run's last bubble squares off its near-bottom corner, so
        // a block of messages reads as one shape with a point at the end rather
        // than a stack of identical lozenges.
        !large && endsRun && (mine ? styles.tailMine : styles.tailTheirs),
      ]}
    >
      {/* Inside the bubble, above the text — the standard treatment, and it
          means the action menu's preview (which re-renders this component)
          shows the quote too, so you can see exactly what you're acting on. */}
      {message.reply_to ? (
        <QuotedMessage quoted={quoted} mine={mine} onPress={onQuotePress} />
      ) : null}
      <MessageText message={message} mine={mine} large={large} />
      {/* The meta line: time, the edited marker, then the tick. A row rather
          than one string because the tick is a glyph, and it has to sit on the
          text's baseline without the emoji-ish drift a font fallback gives. */}
      {showMeta ? (
        <View style={[styles.meta, large && styles.metaBare]}>
          <Text
            style={[
              styles.time,
              large ? styles.bareTime : mine ? styles.mineTime : styles.theirsTime,
            ]}
          >
            {formatMessageTime(message.created_at)}
            {/* An edit is disclosed, never silent: a thread is a shared record, and
                quietly changing what someone already read would make it worthless
                as one. */}
            {message.is_edited ? ' · Edited' : ''}
          </Text>
          {status && status !== 'failed' ? (
            <SendTick status={status} onSurface={!large} />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * A message's words, with URLs and email addresses made tappable (Phase 9b M5).
 *
 * The cheapest "this feels broken" fix in the whole phase: a link someone sends
 * was dead text you had to retype by hand. Splitting and styling happens in
 * `messageText.ts`; this only decides what it looks like and what a tap does.
 *
 * 🔒 **Nothing is fetched.** Link *previews* are on the phase's "not building"
 * list — they'd mean the server retrieving every URL anyone pastes, which is a
 * tracking leak and an SSRF surface for a thumbnail. An underline and
 * `Linking.openURL` involve neither.
 */
function MessageText({
  message,
  mine,
  large,
}: {
  message: Message;
  mine: boolean;
  large: boolean;
}) {
  const base = [
    large ? styles.largeEmoji : styles.text,
    !large && (mine ? styles.mineText : styles.theirsText),
  ];
  const segments = linkify(message.text);
  // The overwhelmingly common case: one run, one Text, no map.
  if (segments.length === 1 && segments[0].kind === 'text') {
    return <Text style={base}>{message.text}</Text>;
  }
  return (
    <Text style={base}>
      {segments.map((segment, index) =>
        segment.kind === 'link' ? (
          <Text
            // Position is a stable key here: the array is derived from an
            // immutable string, so the same text always splits the same way.
            key={`link-${index}`}
            style={mine ? styles.linkMine : styles.linkTheirs}
            accessibilityRole="link"
            // Swallowed: a URL the OS has no handler for (a scheme nobody has
            // installed) rejects, and there is nothing useful to say about it
            // that the person tapping doesn't already know.
            onPress={() => Linking.openURL(segment.url).catch(() => {})}
          >
            {segment.text}
          </Text>
        ) : (
          <Text key={`text-${index}`}>{segment.text}</Text>
        )
      )}
    </Text>
  );
}

/**
 * The tick (Phase 9b M4). Only one of the three states is worth noticing, so
 * only one is drawn at full strength: **read** goes to solid white against the
 * accent fill, while sending and sent sit at the same muted opacity as the
 * timestamp beside them. A tick that shouts on every message is a tick nobody
 * reads.
 *
 * It's always on your own bubble — which is always the accent fill, including
 * in the copy the action menu re-renders — so the colours need no near/far
 * pairing of their own.
 */
function SendTick({
  status,
  onSurface = true,
}: {
  status: Exclude<SendState, 'failed'>;
  /**
   * False for an emoji-only message (Phase 9b M5), which has no accent fill
   * behind it — white-on-white would be an invisible tick, so it takes the
   * page's own ink colours instead.
   */
  onSurface?: boolean;
}) {
  const strong = onSurface ? '#ffffff' : colors.accent;
  const muted = onSurface ? 'rgba(255,255,255,0.7)' : colors.inkFaint;
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={
        status === 'sending' ? 'Sending' : status === 'read' ? 'Read' : 'Sent'
      }
      style={styles.tick}
    >
      <SendStateIcon
        state={status}
        color={status === 'read' ? strong : muted}
        size={13}
      />
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
 * **Both come from the resolved message, never from the reply.** A reply's
 * payload carries a bare `{ id }`; the body *and the author* come from a message
 * the client already holds, or from the focused thread's own fetch, both of
 * which go through the server's interval clipping. That's what stops a quote
 * becoming a window into history the viewer was clipped out of — including the
 * narrow version where the words stay hidden but the name doesn't, which matters
 * in a group where someone can join, post and leave inside your gap.
 *
 * So an unresolved quote shows no name at all, and that's the honest rendering:
 * "Original message unavailable" is a *true* statement about a message the
 * viewer isn't entitled to, not a loading state, and there is nothing further to
 * say about it.
 */
function QuotedMessage({
  quoted,
  mine,
  onPress,
}: {
  /** The message being answered, if the caller could resolve it. */
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
          ? quoted
            ? `In reply to ${quoted.sender.display_name} — open thread`
            : 'In reply to a message you can’t see — open thread'
          : undefined
      }
      style={[styles.quote, mine ? styles.quoteMine : styles.quoteTheirs]}
    >
      {quoted ? (
        <Text
          style={[
            styles.quoteName,
            mine ? styles.quoteNameMine : styles.quoteNameTheirs,
          ]}
          numberOfLines={1}
        >
          {quoted.sender.display_name}
        </Text>
      ) : null}
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
  endsRun = true,
  quoted,
  status,
  onLongPress,
  onShowReactors,
  onOpenThread,
  onRetry,
  onDiscard,
}: {
  message: Message;
  mine: boolean;
  showSender: boolean;
  /**
   * Last bubble of a run from this sender (Phase 9b M5). Decided by the caller,
   * which is the only place that can see the neighbours — it drives the tail
   * corner, the timestamp, and the tighter spacing that makes a burst read as
   * one block. Defaults true so a bubble drawn alone looks finished.
   */
  endsRun?: boolean;
  /** The message this one replies to, if the caller could resolve it. */
  quoted?: Message;
  /** Its send state (Phase 9b M4) — your own messages only; see `BubbleBody`. */
  status?: SendState;
  /**
   * Opens the action menu, anchored to this bubble's rect on screen. Omitted
   * inside the focused thread view, which is deliberately menu-less — see
   * `MessageThreadView`. Also omitted while a message is still in the outbox:
   * every action on it (edit, delete, react, report) needs a server id it
   * hasn't got yet.
   */
  onLongPress?: (anchor: BubbleAnchor) => void;
  /** Open "who reacted" for this message — what tapping a pill does. */
  onShowReactors?: () => void;
  /** Open the focused thread view — what the reply-count affordance does. */
  onOpenThread?: () => void;
  /** Send it again — offered under a `failed` bubble, with `onDiscard`. */
  onRetry?: () => void;
  /** Give up on a failed send and drop it. The only way text ever leaves. */
  onDiscard?: () => void;
}) {
  const bubbleRef = useRef<View>(null);
  const reactions = message.reactions ?? [];
  const replyCount = message.reply_count ?? 0;

  function handleLongPress() {
    if (!onLongPress) return;
    // A light tap under the finger is most of what makes the gesture feel
    // deliberate rather than accidental. Fire and forget — a phone without a
    // taptic engine simply resolves it.
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    // Measure first, open second: the menu positions itself from this rect, so
    // opening before it lands would put the menu somewhere and then move it.
    measureInWindow(bubbleRef.current, onLongPress);
  }

  return (
    // Tighter inside a run than between them (Phase 9b M5): the gap is what
    // tells you where one person's burst ends and the next begins, so it has to
    // mean something. Every bubble spaced equally is the shape the thread had
    // before, and it read as a wall.
    <View style={[styles.row, !endsRun && styles.rowInRun]}>
      {showSender && (
        <View style={styles.senderLine}>
          <Avatar user={message.sender} size="xs" />
          <Text style={styles.senderName} numberOfLines={1}>
            {message.sender.display_name}
          </Text>
        </View>
      )}

      <View style={[styles.bubbleRow, mine ? styles.alignEnd : styles.alignStart]}>
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
            style={[styles.bubbleWrap, status === 'failed' && styles.unsent]}
          >
            <BubbleBody
              message={message}
              mine={mine}
              quoted={quoted}
              status={status}
              endsRun={endsRun}
              onQuotePress={onOpenThread}
            />
          </Pressable>
        )}
      </View>

      {/* A failed send stays exactly where you left it, dimmed, with the two
          ways out beside the reason. **It is never dropped for you** — the text
          is something a person typed, and silently losing it is the one
          outcome this whole path exists to prevent. Discard is right there so
          "get rid of it" is still one tap, but it has to be your tap. */}
      {status === 'failed' ? (
        <View style={[styles.failedRow, styles.alignEnd]}>
          <Text style={styles.failedText}>Not sent</Text>
          <Pressable
            onPress={onRetry}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Try sending again"
          >
            <Text style={styles.failedAction}>Retry</Text>
          </Pressable>
          <Pressable
            onPress={onDiscard}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Discard this message"
          >
            <Text style={styles.failedDiscard}>Discard</Text>
          </Pressable>
        </View>
      ) : null}

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
  // Inside a run. Not zero: the bubbles still need a hairline between them, and
  // at 2px they read as stacked rather than as one very tall message.
  rowInRun: { marginBottom: 2 },
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
  // The tail — the run's last bubble only, on the side it's aligned to.
  tailMine: { borderBottomRightRadius: radius.sm },
  tailTheirs: { borderBottomLeftRadius: radius.sm },
  // An emoji-only message has no bubble at all: the glyph is the message, and a
  // container around it would be a frame around a gesture.
  bare: { paddingVertical: spacing.xs },
  largeEmoji: { fontSize: 44, lineHeight: 52 },
  text: { fontSize: fontSize.base - 1, lineHeight: 21 },
  mineText: { color: '#ffffff' },
  theirsText: { color: colors.ink },
  // Underlined as well as tinted: on the accent fill a lighter shade of white
  // is not a strong enough signal on its own, and colour alone never is.
  linkMine: { color: '#ffffff', textDecorationLine: 'underline' },
  linkTheirs: { color: colors.accentDeep, textDecorationLine: 'underline' },
  meta: {
    marginTop: 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  // No bubble to sit inside, so the meta line aligns with the emoji above it.
  metaBare: { marginTop: 0 },
  bareTime: { color: colors.inkFaint },
  time: { fontSize: 11 },
  mineTime: { color: 'rgba(255,255,255,0.7)' },
  theirsTime: { color: colors.inkFaint },
  // Nudged down a hair: the glyph's optical centre sits above its box, so
  // aligning the boxes leaves the tick floating over the timestamp's baseline.
  tick: { marginTop: 1 },
  // A send that hasn't landed is faded rather than restyled — it's the same
  // message, just not there yet, and a different colour would read as a
  // different kind of thing.
  unsent: { opacity: 0.55 },
  failedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  failedText: { fontSize: fontSize.sm - 1, color: colors.danger },
  failedAction: {
    fontSize: fontSize.sm - 1,
    fontWeight: '700',
    color: colors.accent,
  },
  failedDiscard: { fontSize: fontSize.sm - 1, color: colors.inkFaint },
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
