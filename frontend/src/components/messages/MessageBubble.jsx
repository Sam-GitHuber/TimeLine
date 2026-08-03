import { useMemo, useRef, useState } from "react";
import Avatar from "../Avatar.jsx";
import Lightbox from "../Lightbox.jsx";
import DrawerPopover from "./DrawerPopover.jsx";
import MessageMenu from "./MessageMenu.jsx";
import MessageText from "./MessageText.jsx";
import ReactorsPopover from "../ReactorsPopover.jsx";
import { isEmojiOnly } from "../../messageText.js";
import { useReactionFailures } from "../../reactionFailures.js";
import { formatClockTime } from "../../utils.js";

// One message row — yours align right (filled accent), theirs left. A deleted
// message leaves a muted placeholder in its original spot (and skips the
// arrival animation: it replaces a message in place, it doesn't arrive).
//
// In a group, an incoming message also says *who* sent it — without that, three
// people's bubbles are indistinguishable left-aligned rectangles. Face and name
// sit together on one line above the run they label (`showSender` — see the
// caller), so the bubbles themselves stay flush left and keep their full width
// on a narrow drawer. 1:1 threads pass `showSender` false throughout: there's
// only one person it could be.
//
// Phase 9b M9b brought the app's transcript across: clock times rather than
// "5m ago" (the separator above answers *which day*, so what a bubble has to
// answer is when in it), run grouping, an "Edited" marker, links you can click,
// emoji-only messages drawn large, and the ⋯ menu that replaced the inline
// Delete. M9c added reaction pills, and — on your own messages — a clock while
// a send is in flight, a tick when it lands, and Retry/Discard when it doesn't.
// M9d added the two halves of a reply thread: a collapsed quote inside a reply's
// bubble, and a "3 replies" branch under a root. M9f added highlighted
// @mentions and the tick-box a bubble grows in select mode. M9g replaced the
// quote with the **strand edge** — one bar down a reply's outer side, and a
// click anywhere on the bubble opens the strand it belongs to.
export default function MessageBubble({
  message,
  mine,
  showSender,
  startsRun = true,
  endsRun = true,
  getActions,
  /**
   * Display names for this message's mention ids (M9f), so `@Ada` in the text
   * can be told from someone writing about an email address. The caller owns the
   * map because it's the screen that holds the participants — and it covers
   * *everyone* including you, since a message naming you has to light up as much
   * as one naming anyone else.
   */
  mentionNames,
  /**
   * Select mode (M9f): tick this bubble, or untick it. Present only while
   * selecting, and only on messages the server has actually accepted — an unsent
   * one has no id to copy or delete by, so offering it a tick-box would be
   * offering to include it in an action it can't be part of.
   *
   * While it's present the row's own click *is* the toggle, and the caller drops
   * the ⋯ menu, the reaction row and the strand links for the same reason the
   * app's long-press menu stands down: two modes racing for one gesture.
   */
  onToggleSelect,
  /** Whether this bubble is currently ticked. */
  selected = false,
  /**
   * Drawn inside the strand panel rather than out in the transcript (M9g).
   * **Everything in a strand belongs to that strand**, so a mark saying so on
   * every bubble would say nothing: in here they're plain bubbles. Defaults
   * false, so the transcript and a bubble drawn on its own agree.
   */
  insideStrand = false,
  /**
   * Open this message's strand. Wired to all the ways in — the bubble itself
   * once it wears a strand edge, and a root's reply count — and omitted where
   * there is no strand to open, which is what keeps a bubble inert rather than
   * clickable-but-doing-nothing.
   */
  onOpenThread,
  /**
   * `sending` / `failed` (from the outbox) or `sent` / `read` (computed from
   * participants' read markers) — and `undefined` on everyone else's messages,
   * where a tick would be telling you that you read it, and on your own when
   * either side has read receipts off.
   */
  status,
  /**
   * Toggle an emoji on this message. Absent in a thread you can no longer send
   * to, which drops both the menu's quick row and "tap to remove" in the
   * who-reacted list — the list stays readable and inert, the same line the
   * server draws.
   *
   * **Returns a promise that rejects on refusal** — the caller owns the write,
   * the bubble owns saying so (see `react` below). A caller that resolves
   * regardless leaves the failure unreported, silently.
   */
  onReact,
  /** Which row in the who-reacted list is yours, so it can offer to undo. */
  meId,
  /** Send a failed message again, and give up on it. Both only on `failed`. */
  onRetry,
  onDiscard,
  /**
   * Whether this bubble gets the arrival animation. False for the one that
   * replaces your own optimistic bubble: the row is keyed on the message id, so
   * swapping a temp id for the server's remounts it, and `.msg-bubble` would
   * fade the message up from nothing a moment after it appeared. See
   * `justSent` in `ConversationThreadView`.
   */
  animate = true,
}) {
  const reactions = message.reactions ?? [];
  const [whoOpen, setWhoOpen] = useState(false);
  // Which of this message's photos the lightbox is showing, or null for closed.
  // An index rather than a boolean because `MESSAGE_ATTACHMENTS_MAX` is a server
  // constant: it's 1 today, and a bubble that already knows *which* photo was
  // clicked doesn't need revisiting the day it isn't.
  const [photoIndex, setPhotoIndex] = useState(null);
  const pillsRef = useRef(null);

  /**
   * Reacting, and holding on to a rejection (issue #251).
   *
   * **The bubble reports it, not the caller** — the same rule the file already
   * follows for a failed *send*, and for the same reason twice over. It's
   * nearest the thing that went wrong; and it's the only place that works from
   * both ways in. The transcript and a reply strand each render these bubbles
   * and each call the *one* mutation in `ConversationThreadView`, whose error
   * line used to live in the composer block — a block the thread view gives
   * Tailwind `hidden` while a strand is open, so a reaction refused inside a
   * strand painted its message into a `display: none` subtree and said nothing
   * at all. With no optimistic pill to take away (M2's fifth decision), that
   * left the tap byte-for-byte identical to one that worked, so you tap again,
   * at a server that may have taken the first one, where the second tap is a
   * *removal*.
   *
   * `message.reactions` is the summary to judge against: it only ever holds
   * what the server sent, patched in from a toggle's own response or a poll.
   */
  const { failures: reactionFailures, attempt } = useReactionFailures(reactions);
  // Never rejects (`attempt` swallows it into state), which matters: both call
  // sites below fire and forget, and a rejecting handler there would be an
  // unhandled rejection rather than an error message.
  const react = onReact ? (emoji) => attempt(emoji, () => onReact(emoji)) : undefined;

  /**
   * The timestamp is shown on the run's **last** bubble only. Five messages sent
   * in one minute don't each need the same clock time standing where the next
   * message should be.
   *
   * Two exceptions, and both are load-bearing rather than tidy-ups. An
   * **"Edited"** marker is a *disclosure* — `messaging.md` calls it the thing
   * that makes editing safe at all — so it can't be suppressed by where a bubble
   * happens to sit in a run. And an **unsent** message has to show its clock or
   * its failure wherever it lands, or two queued messages would leave the first
   * looking sent.
   */
  const unsent = status === "sending" || status === "failed";
  const showMeta = endsRun || message.is_edited || unsent;
  /**
   * One to three emoji and nothing else: drop the bubble and draw it large, the
   * treatment every mainstream messenger gives it. Not for a tombstone (no text
   * of its own) and not for a photo message, which needs a bubble to sit in.
   *
   * **And not for a reply** (M9g), which is the phone's rule adopted here: a
   * reply's marker is a bar down the bubble's edge, so it needs a bubble to have
   * an edge. Before the bar, this branch drew an emoji-only reply large with its
   * quote stacked above it — the one place the two clients disagreed about what
   * an emoji-only reply looks like.
   */
  const photos = message.attachments ?? [];
  const large =
    !message.reply_to &&
    !message.is_deleted &&
    photos.length === 0 &&
    isEmojiOnly(message.text);
  const clock = formatClockTime(message.created_at);
  /**
   * The strand edge (M9g) — a reply out in the transcript wears one bar on its
   * outer side, and clicking the bubble opens the strand it belongs to. Inside a
   * strand it wears its quote instead and the bubble is inert: you're already
   * where the bar would take you.
   */
  const edged = Boolean(message.reply_to) && !insideStrand;
  const opensThread = edged && Boolean(onOpenThread) && !onToggleSelect;

  /**
   * A click anywhere on the bubble opens the strand — except when it's the end
   * of a text selection, which on a page you read with a mouse is the one
   * gesture that would otherwise be stolen. The phone has no equivalent problem
   * (selecting text there is a long-press, which is the action menu) and so no
   * equivalent guard.
   */
  function handleBubbleClick(event) {
    if (!opensThread) return;
    // Anything inside the bubble with a job of its own keeps it: the ⋯ menu, a
    // link in the text, a photo, and the edge's own button below — which is why
    // that one doesn't need to stop propagation to avoid firing twice.
    if (event.target.closest("button, a")) return;
    const selection = window.getSelection?.();
    if (selection && !selection.isCollapsed) return;
    onOpenThread();
  }
  /**
   * 🔒 Clipped per viewer by the server (`_with_reply_counts`), not a plain
   * `Count`. A count is small but it's still existence — "3 replies" on a
   * message you can't see would tell a gap member how much happened while they
   * were out. Nothing here has to know that; it just renders what it's given.
   */
  const replyCount = message.reply_count ?? 0;

  /**
   * The names this message's mention ids resolve to (M9f).
   *
   * 🔒 Resolved here, from names the *viewer* already has. The message carries
   * bare ids, so an id belonging to someone this viewer can't see resolves to
   * nothing and its `@Ada` simply renders as the words the sender typed — which
   * is the honest outcome, and the same rule an unresolvable reply quote follows.
   *
   * Memoised so the parse below it can be: an unstable array would defeat
   * `MessageText`'s own memo on every poll.
   */
  const mentions = useMemo(
    () =>
      mentionNames
        ? (message.mentions ?? [])
            .map((id) => mentionNames.get(id))
            .filter(Boolean)
        : undefined,
    [message.mentions, mentionNames]
  );

  const body = (
    <>
      {showSender && (
        <span className="mb-1 flex items-center gap-1.5">
          <Avatar user={message.sender} size="xs" />
          <span className="truncate text-xs font-medium text-ink-soft">
            {message.sender.display_name}
          </span>
        </span>
      )}

      <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
        {message.is_deleted ? (
          <span className="msg-bubble-body rounded-2xl bg-ink/[0.03] py-2 text-sm italic text-ink-faint">
            Message deleted
          </span>
        ) : (
          // `msg-menu-host` is what makes the corner the menu's: it's the
          // positioning context, and on an input that can't hover — where the
          // trigger is permanently visible — it reserves the space so the ⋯
          // never sits on the words. Applied to every live bubble rather than
          // only those that currently have a menu, so a bubble doesn't change
          // width underneath you the moment a send settles.
          <div
            onClick={opensThread ? handleBubbleClick : undefined}
            className={`msg-menu-host ${status === "failed" ? "opacity-60" : ""} ${
              large
                ? // A column, so an emoji-only message still sits on the side its
                  // sender's bubbles do rather than floating at the far left of a
                  // full-width box, reading as detached from the run it's in.
                  `flex max-w-[78%] flex-col ${mine ? "items-end" : "items-start"}`
                : `msg-bubble-body max-w-[78%] rounded-2xl py-2 ${
                    mine
                      ? "bg-accent text-white"
                      : "bg-raised text-ink ring-1 ring-line"
                  }`
            } ${
              // The strand edge (M9g). Theirs takes the accent on the left;
              // yours takes white on the accent fill on the right, inside a
              // 1px `accent-deep` ring — white against the warm ground has no
              // outer edge of its own, and the ring is what it ends against.
              // `ring` rather than a border on both counts: it draws outside the
              // box, so the words don't move when a message becomes a reply.
              edged
                ? mine
                  ? "border-r-[3px] border-r-white/85 ring-1 ring-accent-deep"
                  : "border-l-[3px] border-l-accent"
                : ""
            } ${opensThread ? "cursor-pointer" : ""}`}
          >
            {/* The keyboard and screen-reader route to the same thing the click
                does. It sits *on* the bar rather than being an extra control
                somewhere: a strip of the bubble's own edge, invisible until
                focused, which is what stops "open the thread" from being a
                mouse-only affordance.

                🔒 It says "part of a thread" and no more, for the same reason
                the bar draws no name: the root may be one this viewer was
                clipped out of, and a label naming it would hand over exactly
                what the payload withholds. */}
            {opensThread && (
              <button
                type="button"
                onClick={onOpenThread}
                aria-label="Part of a thread — open thread"
                className={`absolute inset-y-0 w-3 rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                  mine ? "right-0" : "left-0"
                }`}
              />
            )}
            {/* Inside the bubble, in its top-right corner. It used to sit
                *beside* the bubble, which pushed the whole bubble in off the
                panel edge — and left the reaction pills, which hang off the
                bubble's own edge, no longer lined up under it. A message's
                actions belong on the message.

                No menu on a tombstone: there's nothing left to act on. And none
                on an **unsent** message either — every action it offers (edit,
                delete, react, report) needs a server id it hasn't got yet. */}
            {!unsent && getActions && (
              <MessageMenu
                getActions={() => getActions(message)}
                onFill={mine && !large}
                onReact={react}
                reactedEmojis={
                  new Set(
                    reactions.filter((r) => r.reacted).map((r) => r.emoji)
                  )
                }
              />
            )}
            {/* Photos (Phase 9b M7 on the phone, properly here in M9e — this
                replaced a stopgap thumbnail that linked to the raw file in a new
                tab). */}
            {photos.map((attachment, index) => (
              <MessagePhoto
                key={attachment.id}
                attachment={attachment}
                // An unsent photo has nowhere full-size to open: both its URLs
                // point at the same local thumbnail, so a lightbox would be a
                // blurry copy of what's already on screen pretending to be more.
                onOpen={unsent ? undefined : () => setPhotoIndex(index)}
              />
            ))}
            {message.text && (
              <MessageText
                text={message.text}
                mine={mine}
                large={large}
                mentions={mentions}
              />
            )}
            {showMeta && (
              // The meta line: time, the edited marker, then the tick. A row
              // rather than one string because the tick is a glyph and has to
              // sit on the text's baseline.
              <span
                className={`mt-0.5 flex items-center gap-1 font-mono text-[0.65rem] ${
                  large
                    ? "text-ink-faint"
                    : mine
                      ? "text-white/70"
                      : "text-ink-faint"
                }`}
                title={message.created_at}
              >
                <span>
                  {clock.time}
                  {clock.meridiem}
                  {/* An edit is disclosed, never silent: a thread is a shared
                      record, and quietly changing what someone already read
                      would make it worthless as one. */}
                  {message.is_edited ? " · Edited" : ""}
                </span>
                {status && status !== "failed" && (
                  <SendTick status={status} onSurface={mine && !large} />
                )}
              </span>
            )}
          </div>
        )}
      </div>

      {/* A failed send stays exactly where you left it, dimmed, with the two
          things you might want: send it again, or let it go. Nothing is thrown
          away without a click, because losing text someone typed is the outcome
          this whole path exists to prevent. */}
      {status === "failed" && (
        <div className="mt-0.5 flex items-center justify-end gap-2 pr-1 text-xs">
          <span className="text-red-600">Not sent</span>
          <button
            type="button"
            onClick={onRetry}
            className="font-medium text-accent-deep transition hover:underline"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={onDiscard}
            aria-label="Discard this message"
            className="text-ink-faint transition hover:text-ink"
          >
            Discard
          </button>
        </div>
      )}
      {/* What the server said, on its own line under the controls (M9e).
          **Beside "Not sent", never instead of it**: the fact and the reason
          answer different questions, and a bubble that swapped one for the other
          would trade "this didn't send" for a sentence you have to parse to work
          out that much.

          Most failures have nothing to add — a network blink carries no message,
          and Retry is the whole answer — so this is usually absent. It earns its
          place on the ones that will fail again however often they're retried: a
          photo over the byte cap, a thread you've been severed from. Without it,
          Retry is a button that can only disappoint. */}
      {status === "failed" && message.outboxError && (
        <p className="mt-0.5 pr-1 text-right text-xs text-ink-faint">
          {message.outboxError}
        </p>
      )}

      {/* The pills, hanging off the bubble's lower edge on its near side.
          **One gesture: a click opens "who reacted", it never toggles the
          reaction.** A pill is a *display* of what the thread said, so a click
          goes to the detail of it rather than silently changing it —
          deliberately unlike the feed's chips, which do toggle, because a post
          has no ⋯ menu to carry the alternative and a message has two better
          homes for it (the menu's emoji row, and "tap to remove" in the list
          this opens).

          Rendered on a **tombstone** too, and that's the point rather than an
          oversight: a reaction someone left is a thing that happened, and
          dropping it when the message is deleted would make it look as though
          they never did. It's also load-bearing — a tombstone has no ⋯ menu, so
          this is the *only* route left to take your own reaction off one, which
          is why the server keeps a deleted message removal-only rather than
          refusing both (reactions.md). */}
      {reactions.length > 0 && (
        // ⚠️ `relative z-10` is what keeps the overlap the right way up, and it
        // has to stay paired with the negative margin. The row is pulled up to
        // sit on the bubble's edge — but the bubble is *positioned* now (it's
        // the ⋯ menu's anchor), and a positioned element paints over in-flow
        // content whatever the DOM order, so without this the bubble covers the
        // top of every pill and they read as clipped.
        <div
          ref={pillsRef}
          className={`relative z-10 -mt-1 flex flex-wrap gap-1 ${
            mine ? "justify-end pr-1" : "justify-start pl-1"
          }`}
        >
          {reactions.map((reaction) => (
            <button
              key={reaction.emoji}
              type="button"
              // Toggles the list rather than only opening it: both this and the
              // popover's own outside-click handler treat the pill row as the
              // anchor and ignore clicks on it, so an open-only pill would leave
              // the thing it opened with no way to shut it from where you are.
              onClick={() => setWhoOpen((open) => !open)}
              aria-expanded={whoOpen}
              aria-label={`${reaction.emoji}, ${reaction.count}${
                reaction.reacted ? ", including you" : ""
              } — see who reacted`}
              className={`inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-xs transition ${
                reaction.reacted
                  ? "border-accent bg-accent-tint text-accent-deep"
                  : "border-line bg-raised text-ink-faint hover:border-line-strong"
              }`}
            >
              <span aria-hidden="true" className="leading-none">
                {reaction.emoji}
              </span>
              {/* A lone reaction needs no "1" beside it — the emoji is the whole
                  message. The count only earns its space once it's ambiguous. */}
              {reaction.count > 1 && (
                <span className="font-mono tabular-nums">{reaction.count}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* A refused reaction, under the pills and on the bubble's own side.
          Outside the pills block rather than inside it: adding your *first*
          emoji to a message is exactly the case where there are no pills to sit
          under, and it's the one that fails on the per-target cap least and on
          being offline most.

          Each names its own emoji — with two of these up, identical red lines
          would say nothing about which tap failed. Deliberately not
          `aria-hidden`: which emoji it's about is the part a screen reader most
          needs, and an emoji is announced by name. */}
      {Object.entries(reactionFailures).map(([emoji, failure]) => (
        <p
          key={emoji}
          role="alert"
          className={`mt-0.5 text-xs leading-snug text-red-600 ${
            mine ? "pr-1 text-right" : "pl-1 text-left"
          }`}
        >
          {emoji} {failure.text}
        </p>
      ))}

      {/* The way into a strand from its root (M9d), and the *only* click that
          opens it from here — the bubble's own click stays free, the gesture
          budget M2 settled. Drawn as a branch off the bubble, the same living
          line the feed's comment threads use, so a strand reads as growing out
          of the message rather than as a button stuck under it.

          Its absence is what makes the quote load-bearing: a root the viewer was
          clipped out of never renders, so its replies stand alone with no count
          to click, and the quote is the only way in left. */}
      {replyCount > 0 && onOpenThread && (
        <div
          className={`mt-0.5 flex ${mine ? "justify-end pr-1" : "justify-start pl-1"}`}
        >
          <button
            type="button"
            onClick={onOpenThread}
            className="flex items-center gap-1.5 text-xs font-semibold text-accent-deep transition hover:underline"
          >
            <span aria-hidden="true" className="h-px w-3.5 bg-line-strong" />
            {replyCount} {replyCount === 1 ? "reply" : "replies"}
          </button>
        </div>
      )}

      {/* From a bubble the lightbox opens the *message's* photo, not the chat's
          gallery: here the message is the unit, and flipping from someone's
          picture into the rest of the thread's is a different intention. The
          info panel's gallery is where you swipe between them (M9e).

          It's a portal on `<body>` at `z-50`, above the drawer's `z-40` — so
          unlike the phone, a photo inside a **reply strand** opens perfectly
          well. The app leaves that one inert because its strand is a `Modal` and
          iOS won't stack two; the web has no such trap, so it doesn't inherit
          the restriction. */}
      {photoIndex !== null && (
        <Lightbox
          images={photos.map((attachment) => ({
            id: attachment.id,
            image: attachment.url,
            thumbnail: attachment.thumbnail,
          }))}
          index={photoIndex}
          onIndexChange={setPhotoIndex}
          onClose={() => setPhotoIndex(null)}
        />
      )}

      {whoOpen && (
        <DrawerPopover
          anchorRef={pillsRef}
          width={256}
          height={288}
          bare
          onClose={() => setWhoOpen(false)}
        >
          <ReactorsPopover
            messageId={message.id}
            meId={meId}
            onRemoveReaction={react}
            onClose={() => setWhoOpen(false)}
            ignoreRef={pillsRef}
          />
        </DrawerPopover>
      )}
    </>
  );

  return (
    // The gap goes *above* each row, and is tighter inside a run — consecutive
    // messages from one person read as a block rather than a stack of separate
    // ones. Above rather than below because the transcript scroller is
    // `column-reverse`: margins stay physical while the order flips, so "the row
    // visually above me" is the one this margin separates us from either way.
    <li
      className={`${
        message.is_deleted || !animate ? "" : "msg-bubble"
      } group flex flex-col ${startsRun ? "mt-2" : "mt-0.5"} ${
        selected ? "rounded-xl bg-accent-tint" : ""
      }`}
    >
      {onToggleSelect ? (
        /**
         * Select mode (M9f). The tick-box is the accessible control and the row
         * around it is the convenient one — a click anywhere on the message
         * toggles it, which is what the app's tap does and what anyone who has
         * used a messenger expects.
         *
         * ⚠️ **`onClickCapture`, and the `preventDefault` is the point.** The row
         * still contains links, a photo, a quote and a reply count, all of which
         * would otherwise fire on the click that was meant to tick the box —
         * opening a lightbox or navigating away mid-selection. Intercepting in
         * the capture phase settles all of them in one place, rather than
         * threading a "we're selecting" flag into every child that has a click.
         * In practice it's stronger than `preventDefault` alone: stopping a
         * React capture-phase event halts the *native* dispatch too, so a link
         * in here never sees the click at all.
         *
         * It reaches the portalled popovers as well, because a portal
         * propagates through the React tree rather than the DOM one. That's
         * moot rather than wrong — nothing in this row can open one while
         * selecting, and an already-open one is closed by the very click that
         * opened the ⋯ menu you entered the mode from.
         */
        <div
          onClickCapture={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onToggleSelect();
          }}
          className="flex items-start gap-2"
        >
          <input
            type="checkbox"
            checked={selected}
            // Read-only because the toggle is handled above, for everything in
            // the row at once — including a keyboard's Space on this very box,
            // which arrives here as a click like any other.
            readOnly
            // The time is in the label because a **burst** is what select mode
            // exists for, and a burst is several messages from one person: three
            // boxes all announcing "select message from Priya" would be three
            // controls a screen reader can't tell apart. The clock is what
            // distinguishes them, and it's already on screen beside them.
            aria-label={`Select message from ${message.sender.display_name} at ${clock.time}${clock.meridiem}`}
            className="mt-2 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
          />
          <div className="flex min-w-0 flex-1 flex-col">{body}</div>
        </div>
      ) : (
        body
      )}
    </li>
  );
}

/**
 * How wide a photo is allowed to draw inside a bubble, in px.
 *
 * The drawer is 400px, the transcript pads 16px each side and the bubble stops
 * at 78% of what's left, of which its own padding and the ⋯ corner take ~60 —
 * so this is the content width, not a taste. A photo drawn wider would be the
 * one thing in the transcript that could push the bubble past its own limit.
 */
const PHOTO_MAX_WIDTH = 224;
/** And how tall, so a portrait shot doesn't take the whole panel and bury the
 * message under it. A tall photo is letterboxed narrower, not cropped. */
const PHOTO_MAX_HEIGHT = 288;

/**
 * A photo in a bubble (Phase 9b M9e), drawn at a **known size** and opening the
 * shared `Lightbox`.
 *
 * ⚠️ **The size is the whole point of the width/height on the payload.** The
 * sender's client measured what it uploaded and sent the numbers along, so the
 * bubble can reserve exactly the right box *before* the image arrives. Without
 * that, every photo that loads while you're scrolled back through history shoves
 * the message you were reading up the panel — which is worse than it sounds, and
 * is the reason those two columns exist on `MessageAttachment` at all.
 *
 * No auth plumbing needed here, unlike the app: `/media/*` is cookie-gated at
 * Caddy (`forward_auth`) and the browser attaches the cookie to an `<img>`
 * request by itself.
 */
function MessagePhoto({ attachment, onOpen }) {
  // Used undefended, because both ends guarantee them: `MessageAttachment`'s
  // columns are non-null and `MessageSerializer` bounds each at `min_value=1`,
  // and the outbox's local stand-in carries what `prepareChatPhoto` measured. An
  // earlier `|| 1` here looked careful and wasn't — it could only ever have
  // turned a missing dimension into a 1×1 image, which is less use than the
  // stretched box it was guarding against.
  const scale = Math.min(
    1,
    PHOTO_MAX_WIDTH / attachment.width,
    PHOTO_MAX_HEIGHT / attachment.height
  );
  const width = Math.round(attachment.width * scale);
  const height = Math.round(attachment.height * scale);

  const image = (
    <img
      src={attachment.thumbnail}
      // Both the attribute pair (so the box exists before any CSS loads) and the
      // style (so it survives a stylesheet that would otherwise size images).
      width={width}
      height={height}
      style={{ width, height }}
      alt="Photo"
      className="rounded-xl bg-ink/[0.04] object-cover"
    />
  );

  // Inert when there's nothing better to open — an unsent photo. A picture that
  // looked clickable and did nothing would be worse than one that plainly isn't.
  if (!onOpen) return <span className="mb-1 block">{image}</span>;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Open photo"
      className="mb-1 block transition hover:opacity-90"
    >
      {image}
    </button>
  );
}

/**
 * The tick (Phase 9b M4, on the web in M9c). Only one of the three states is
 * worth noticing, so only one is drawn at full strength: **read** goes solid
 * against the accent fill, while sending and sent sit at the same muted opacity
 * as the timestamp beside them. A tick that shouts on every message is a tick
 * nobody reads.
 */
function SendTick({ status, onSurface }) {
  // `onSurface` is false for an emoji-only message, which has no accent fill
  // behind it — white-on-white would be an invisible tick, so it takes the
  // page's own ink colours instead.
  const colour = onSurface
    ? status === "read"
      ? "text-white"
      : "text-white/70"
    : status === "read"
      ? "text-accent"
      : "text-ink-faint";
  const label =
    status === "sending" ? "Sending" : status === "read" ? "Read" : "Sent";

  return (
    <span role="img" aria-label={label} className={`inline-flex ${colour}`}>
      {status === "sending" ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          aria-hidden="true"
          className="h-3 w-3"
        >
          <circle cx="12" cy="12" r="8.5" strokeWidth="2" />
          {/* Hands at roughly ten-past-ten: legible as a clock even this small,
              where a vertical-plus-horizontal pair just reads as a cross. */}
          <path
            d="M12 7.5V12l3 2"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg
          viewBox={status === "read" ? "0 0 34 24" : "0 0 24 24"}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={status === "read" ? "h-3 w-[1.05rem]" : "h-3 w-3"}
        >
          <path d="M4 13l5 5L20 7" />
          {status === "read" && <path d="M14 13l5 5L30 7" />}
        </svg>
      )}
    </span>
  );
}
