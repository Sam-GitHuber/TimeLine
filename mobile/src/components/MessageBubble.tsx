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
 * **Inline formatting** (Phase 9b M8). `*bold*`, `_italic_`, `~strikethrough~`
 * and `` `monospace` `` are drawn as what people meant by them rather than left
 * sitting there as stray punctuation — the markup people type out of habit, and
 * a message full of asterisks is what "this app doesn't know that" looks like.
 * The parse is render-time only: the stored text keeps its markup characters, so
 * an edit shows you what you typed and the body stays one blob under E2E.
 *
 * **Photos** (Phase 9b M7) sit above the caption inside the bubble, drawn at the
 * size the sender's phone recorded so the transcript doesn't reflow as they load,
 * and open full-screen on tap. A message may be a photo with no caption at all —
 * which is why the text is now rendered conditionally rather than always.
 *
 * **Select mode** (Phase 9b M8) is the one state where a bubble's own tap does
 * something: it ticks the message, and the row takes an accent wash. That's a
 * suspension of the rule below rather than an exception to it — while selecting,
 * a tap means exactly one thing everywhere on screen, so there's nothing to
 * mistake it for.
 *
 * **One gesture per target**, the rule M2 settled: **long-press** = the action
 * menu (Reply included), **tap the branch** = open the thread. The bubble's own
 * tap does nothing outside select mode, and should stay that way — a target this size doing
 * different things by press duration is where a mis-timed press does the wrong
 * thing. A tappable *link* inside the text is one exception and **a photo is the
 * other**; neither really breaks the rule, because both are smaller targets with
 * their own obvious affordance, and long-pressing over either still opens the
 * menu.
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

import { useMemo, useRef } from 'react';
import * as Haptics from 'expo-haptics';
import {
  Linking,
  Pressable,
  StyleSheet,
  Text,
  type TextStyle,
  View,
} from 'react-native';

import { AuthedImage } from './AuthedImage';
import { Avatar } from './Avatar';
import { SendStateIcon } from './icons';
import type { BubbleAnchor } from './MessageActionMenu';
import { measureInWindow } from '@/measure';
import type { Mark } from '@/messageText';
import { isEmojiOnly, parseMessageText, plainMessageText } from '@/messageText';
import type { SendState } from '@/readReceipts';
import { colors, fonts, fontSize, radius, spacing } from '@/theme';
import type { Message, MessageAttachment, Reaction } from '@/types';
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
  mentionNames,
  onQuotePress,
  onPhotoPress,
  onPhotoLongPress,
}: {
  message: Message;
  mine: boolean;
  /** The message this one replies to, if the caller could resolve it. */
  quoted?: Message;
  /**
   * Display names for the ids in `message.mentions` (Phase 9b M8), so an
   * `@Ada` in the text can be highlighted. Supplied by the screen, which is
   * where the participant list lives; omitted, the names still read fine as
   * ordinary words — the sender typed them into the message.
   */
  mentionNames?: Map<number, string>;
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
  /**
   * Open a photo full-screen (Phase 9b M7). Omitted by the action menu's
   * preview, and by an in-flight bubble — there's nothing full-size to open
   * until the upload lands.
   */
  onPhotoPress?: (photo: MessageAttachment) => void;
  /**
   * Open the action menu from a press-and-hold over a photo (Phase 9b M7).
   * Separate from `onPhotoPress` because a photo is its own touch responder and
   * has to re-offer the gesture itself — see `MessagePhoto`.
   */
  onPhotoLongPress?: () => void;
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
  const photos = message.attachments ?? [];
  const large =
    !message.reply_to &&
    !message.is_deleted &&
    photos.length === 0 &&
    isEmojiOnly(message.text);

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
      {/* Above the caption, below the quote — the order a photo message reads
          in: what you're replying to, the picture, then what you said about it. */}
      {photos.length > 0 ? (
        <View style={styles.photos}>
          {photos.map((photo) => (
            <MessagePhoto
              key={photo.id}
              photo={photo}
              onPress={onPhotoPress ? () => onPhotoPress(photo) : undefined}
              onLongPress={onPhotoLongPress}
            />
          ))}
        </View>
      ) : null}
      {message.text ? (
        <MessageText
          message={message}
          mine={mine}
          large={large}
          mentionNames={mentionNames}
        />
      ) : null}
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

/** What a bubble announces to a screen reader: the words, or "Photo" when
 * there aren't any (a photo with a caption reads as the caption — the photo is
 * announced by the image inside it). */
function describeMessage(message: Message) {
  if (message.text) return message.text;
  return (message.attachments ?? []).length > 0 ? 'Photo' : message.text;
}

/**
 * Longest edge of a photo inside a bubble.
 *
 * Bounded in *both* directions rather than just by width. A portrait phone photo
 * is 3:4, so width-only sizing gives it a bubble taller than the screen is wide
 * and pushes the rest of the conversation off the top — the height cap is what
 * keeps a tall photo from taking over the transcript. Tapping opens it properly.
 */
const PHOTO_WIDTH = 240;
const PHOTO_MAX_HEIGHT = 320;
const PHOTO_MIN_HEIGHT = 96;

/**
 * One photo in a bubble (Phase 9b M7).
 *
 * **The space is reserved before the image arrives**, computed from the
 * `width`/`height` the sender's phone recorded. That's the whole reason those
 * travel with the attachment: without them the row starts at zero height and
 * grows as each thumbnail loads, and a transcript that reflows while you're
 * reading it is the jankiest thing a chat can do — worse when you're scrolled
 * into history, because every load shoves the message you were reading.
 *
 * `AuthedImage`, not `Image`: media is behind `forward_auth` in production, so a
 * plain `<Image>` renders a blank box there while appearing to work in dev.
 */
function MessagePhoto({
  photo,
  onPress,
  onLongPress,
}: {
  photo: MessageAttachment;
  onPress?: () => void;
  /**
   * Opens the bubble's action menu. **Must be re-offered here rather than left
   * to the bubble**: this `Pressable` becomes the touch responder for anything
   * starting on the photo, so a press-and-hold never reaches the wrapper's
   * `onLongPress` at all. Without this the gesture fell through to `onPress` on
   * release and a long-press opened the lightbox — Reply and the rest were
   * unreachable from a photo.
   */
  onLongPress?: () => void;
}) {
  const ratio = photo.height > 0 ? photo.height / photo.width : 1;
  const height = Math.min(
    PHOTO_MAX_HEIGHT,
    Math.max(PHOTO_MIN_HEIGHT, Math.round(PHOTO_WIDTH * ratio))
  );

  return (
    <Pressable
      onPress={onPress}
      // A tap on a photo opening it is the one place the bubble's own "tap does
      // nothing" rule gives way, and it doesn't really break it: a photo is its
      // own target with its own obvious affordance, exactly like a link in the
      // text. Long-press keeps its meaning by being forwarded to the bubble's
      // menu — and passing `onLongPress` is also what stops `onPress` firing on
      // release, so the hold no longer opens the lightbox on the way out.
      onLongPress={onLongPress}
      // Matches the wrapper's, so the hold feels identical over a photo and over
      // the caption beside it.
      delayLongPress={350}
      accessibilityRole={onPress ? 'imagebutton' : 'image'}
      accessibilityLabel={onPress ? 'Photo, tap to open' : 'Photo'}
      accessibilityHint={
        onLongPress ? 'Press and hold for message actions' : undefined
      }
      style={{ width: PHOTO_WIDTH, height }}
    >
      <AuthedImage
        uri={photo.thumbnail}
        style={styles.photo}
        // `cover`: the bubble's slot is already the photo's aspect ratio unless
        // the height cap clipped it, and for the tall ones a filled crop reads
        // far better than a letterboxed strip. The full frame is a tap away.
        contentFit="cover"
        transition={120}
      />
    </Pressable>
  );
}

/**
 * What each emphasis mark looks like (Phase 9b M8).
 *
 * Kept beside the parser's vocabulary rather than inside it: `messageText.ts`
 * decides *what* a run is, this decides how it's drawn — the same split the
 * link segments already had.
 */
const MARK_STYLE: Record<Mark, TextStyle> = {
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  strike: { textDecorationLine: 'line-through' },
  // Monospace also drops a hair in size, because at a shared point size a mono
  // face reads noticeably larger than the body text beside it.
  mono: { fontFamily: fonts.mono, fontSize: fontSize.base - 3 },
};

function markStyles(marks: Mark[] | undefined): TextStyle[] {
  return marks ? marks.map((mark) => MARK_STYLE[mark]) : [];
}

/**
 * A message's words: URLs and email addresses made tappable (Phase 9b M5), and
 * `*bold*` / `_italic_` / `~strikethrough~` / `` `monospace` `` drawn as what
 * people meant by them (Phase 9b M8).
 *
 * The cheapest "this feels broken" fixes in the whole phase — a link someone
 * sends was dead text you had to retype by hand, and the markup people type out
 * of habit sat there as literal asterisks. Splitting happens in
 * `messageText.ts`; this only decides what each run looks like and what a tap
 * does.
 *
 * 🔒 **Nothing is fetched, and nothing is rewritten.** Link *previews* are on
 * the phase's "not building" list — they'd mean the server retrieving every URL
 * anyone pastes, which is a tracking leak and an SSRF surface for a thumbnail.
 * And the markup is only ever *unrendered*, never stripped from the stored text:
 * the raw string is the source of truth, so an edit shows you exactly what you
 * typed and the body stays one opaque blob under E2E.
 */
function MessageText({
  message,
  mine,
  large,
  mentionNames,
}: {
  message: Message;
  mine: boolean;
  large: boolean;
  mentionNames?: Map<number, string>;
}) {
  const base = [
    large ? styles.largeEmoji : styles.text,
    !large && (mine ? styles.mineText : styles.theirsText),
  ];
  /**
   * Split once per message, not once per render.
   *
   * Ordinary text parses in microseconds, so this isn't about the common case —
   * it's about the worst one. The scan asks "does a run close here?" at each
   * delimiter it could open at, which is quadratic on a string full of openers
   * that never close (`*a *a *a …`). At the 5000-character message cap that's
   * tens of milliseconds, and a transcript re-renders on every poll, every
   * keystroke in the composer and every scroll — so an unmemoised parse turns
   * one awkward message into a permanently janky thread. Memoised, it's paid
   * once and the pathological case is bounded.
   *
   * The deps are all reference-stable: the text is immutable, `mentions` comes
   * from the query cache and `mentionNames` is memoised by the screen.
   */
  const segments = useMemo(() => {
    // 🔒 Resolved here, from names the *viewer* already has. The message carries
    // bare ids, so an id belonging to someone this viewer can't see resolves to
    // nothing and its `@Ada` simply renders as the words the sender typed —
    // which is the honest outcome, and the same rule an unresolvable reply quote
    // follows.
    const mentions = mentionNames
      ? (message.mentions ?? [])
          .map((id) => mentionNames.get(id))
          .filter((name): name is string => !!name)
      : [];
    return parseMessageText(message.text, { mentions });
  }, [message.text, message.mentions, mentionNames]);
  // The overwhelmingly common case: one unmarked run, one Text, no map.
  if (segments.length === 1 && segments[0].kind === 'text' && !segments[0].marks) {
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
            style={[
              markStyles(segment.marks),
              mine ? styles.linkMine : styles.linkTheirs,
            ]}
            accessibilityRole="link"
            // Swallowed: a URL the OS has no handler for (a scheme nobody has
            // installed) rejects, and there is nothing useful to say about it
            // that the person tapping doesn't already know.
            onPress={() => Linking.openURL(segment.url).catch(() => {})}
          >
            {segment.text}
          </Text>
        ) : segment.kind === 'mention' ? (
          <Text
            key={`mention-${index}`}
            style={[
              markStyles(segment.marks),
              mine ? styles.mentionMine : styles.mentionTheirs,
            ]}
          >
            {segment.text}
          </Text>
        ) : (
          <Text key={`text-${index}`} style={markStyles(segment.marks)}>
            {segment.text}
          </Text>
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
  // Two lines of plain text, so the markup is dropped rather than drawn (M8):
  // a quote is a *reference* to a message, not a second rendering of it.
  const body = quoted?.is_deleted
    ? 'Message deleted'
    : quoted
      ? plainMessageText(quoted.text)
      : 'Original message unavailable';
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
  mentionNames,
  selected,
  onPress,
  onLongPress,
  onShowReactors,
  onOpenThread,
  onPhotoPress,
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
  /** Names for this message's mention ids (Phase 9b M8); see `BubbleBody`. */
  mentionNames?: Map<number, string>;
  /** Ticked in select mode (Phase 9b M8) — the row takes an accent wash. */
  selected?: boolean;
  /**
   * What a plain tap does. **Only ever passed in select mode**: outside it the
   * bubble's tap deliberately does nothing, for the reason in this file's
   * header. In select mode a tap means one thing everywhere on the screen,
   * which is why the rule can be suspended without becoming ambiguous.
   */
  onPress?: () => void;
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
  /** Open a photo full-screen (Phase 9b M7) — what tapping one does. */
  onPhotoPress?: (photo: MessageAttachment) => void;
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
    <View
      style={[
        styles.row,
        !endsRun && styles.rowInRun,
        // The wash is on the whole row, not the bubble: it has to read as "this
        // message is picked" rather than as a new kind of bubble, and it has to
        // be visible on a tombstone and behind reaction pills too.
        selected && styles.rowSelected,
      ]}
    >
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
            onPress={onPress}
            onLongPress={onLongPress ? handleLongPress : undefined}
            delayLongPress={350}
            accessibilityRole="text"
            accessibilityState={onPress ? { selected: !!selected } : undefined}
            // The label lets the menu be opened by assistive tech and driven in
            // tests, since a long-press isn't otherwise discoverable.
            // A photo with no caption would otherwise announce itself as an
            // empty message, which is how a screen reader reports "nothing here".
            accessibilityLabel={
              mine
                ? `Your message: ${describeMessage(message)}`
                : `Message from ${message.sender.display_name}: ${describeMessage(message)}`
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
              mentionNames={mentionNames}
              onQuotePress={onOpenThread}
              onPhotoPress={onPhotoPress}
              // The same handler the wrapper uses, so the menu anchors to the
              // whole bubble either way — a menu that jumped to the photo's rect
              // when you happened to hold over the picture would read as a
              // different menu.
              onPhotoLongPress={onLongPress ? handleLongPress : undefined}
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
  // Full-bleed by design: the row is inset by the list's padding, and a wash
  // that stopped at the bubble's edge would read as a selected *bubble* rather
  // than a selected message.
  rowSelected: { backgroundColor: colors.accentTint },
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
  // A gap only when there's more than one photo — with a single one (all M7
  // sends today) this collapses to nothing and the caption below keeps its own
  // spacing.
  photos: { gap: spacing.xs, marginBottom: spacing.xs },
  photo: {
    width: '100%',
    height: '100%',
    // Slightly tighter than the bubble's own corner, so the photo sits *inside*
    // it rather than fighting the outline — the same relationship a rounded
    // image has to a rounded card everywhere else in the app.
    borderRadius: radius.md,
    backgroundColor: colors.line,
  },
  text: { fontSize: fontSize.base - 1, lineHeight: 21 },
  mineText: { color: '#ffffff' },
  theirsText: { color: colors.ink },
  // Underlined as well as tinted: on the accent fill a lighter shade of white
  // is not a strong enough signal on its own, and colour alone never is.
  linkMine: { color: '#ffffff', textDecorationLine: 'underline' },
  linkTheirs: { color: colors.accentDeep, textDecorationLine: 'underline' },
  // A mention is weighted rather than underlined (M8): it isn't tappable, and
  // an underline is this app's promise that something opens. Weight plus tint
  // is enough to find a name at a glance in a busy group, which is all a
  // mention has to do.
  mentionMine: { color: '#ffffff', fontWeight: '700' },
  mentionTheirs: { color: colors.accentDeep, fontWeight: '700' },
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
