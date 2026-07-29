import { useRef, useState } from "react";
import Avatar from "../Avatar.jsx";
import Lightbox from "../Lightbox.jsx";
import DrawerPopover from "./DrawerPopover.jsx";
import MessageMenu from "./MessageMenu.jsx";
import MessageText from "./MessageText.jsx";
import ReactorsPopover from "../ReactorsPopover.jsx";
import { isEmojiOnly, plainMessageText } from "../../messageText.js";
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
// bubble, and a "3 replies" branch under a root.
export default function MessageBubble({
  message,
  mine,
  showSender,
  startsRun = true,
  endsRun = true,
  getActions,
  /**
   * The message this one replies to, if the caller could resolve it (M9d).
   *
   * 🔒 **Resolved, never handed over.** `message.reply_to` is a bare `{ id }`,
   * so this comes from the transcript's own loaded messages or from a fetch
   * through the clipped endpoint (`quotes.js`) — the two places the server has
   * already decided this viewer may see. `undefined` is a real answer and gets
   * the honest "Original message unavailable", with **no name above it**.
   */
  quoted,
  /**
   * Open this message's strand. Wired to *both* ways in — a reply's quote and a
   * root's reply count — and omitted where there is no strand to open, which is
   * what keeps the quote inert rather than a button that does nothing.
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
   */
  const photos = message.attachments ?? [];
  const large =
    !message.is_deleted && photos.length === 0 && isEmojiOnly(message.text);
  const clock = formatClockTime(message.created_at);
  /**
   * 🔒 Clipped per viewer by the server (`_with_reply_counts`), not a plain
   * `Count`. A count is small but it's still existence — "3 replies" on a
   * message you can't see would tell a gap member how much happened while they
   * were out. Nothing here has to know that; it just renders what it's given.
   */
  const replyCount = message.reply_count ?? 0;

  return (
    // The gap goes *above* each row, and is tighter inside a run — consecutive
    // messages from one person read as a block rather than a stack of separate
    // ones. Above rather than below because the transcript scroller is
    // `column-reverse`: margins stay physical while the order flips, so "the row
    // visually above me" is the one this margin separates us from either way.
    <li
      className={`${
        message.is_deleted || !animate ? "" : "msg-bubble"
      } group flex flex-col ${
        startsRun ? "mt-2" : "mt-0.5"
      }`}
    >
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
            className={`msg-menu-host ${status === "failed" ? "opacity-60" : ""} ${
              large
                ? // A column, so a quote above an emoji-only message can be full
                  // width while the emoji itself still sits on the side its
                  // sender's bubbles do. Without this the quote sets the box's
                  // width and the emoji floats at the far left of it, reading as
                  // detached from the message it belongs to.
                  `flex max-w-[78%] flex-col ${mine ? "items-end" : "items-start"}`
                : `msg-bubble-body max-w-[78%] rounded-2xl py-2 ${
                    mine
                      ? "bg-accent text-white"
                      : "bg-raised text-ink ring-1 ring-line"
                  }`
            }`}
          >
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
                onReact={onReact}
                reactedEmojis={
                  new Set(
                    reactions.filter((r) => r.reacted).map((r) => r.emoji)
                  )
                }
              />
            )}
            {/* The collapsed quote (M9d) — inside the bubble, above the words,
                so the reply reads as carrying what it answers rather than
                sitting under a separate label. */}
            {message.reply_to && (
              <QuotedMessage
                quoted={quoted}
                // Same test the tick uses: an emoji-only message has no accent
                // fill behind it, so white-on-white would be an invisible quote.
                onFill={mine && !large}
                onOpenThread={onOpenThread}
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
              <MessageText text={message.text} mine={mine} large={large} />
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
            onRemoveReaction={onReact}
            onClose={() => setWhoOpen(false)}
            ignoreRef={pillsRef}
          />
        </DrawerPopover>
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
 * The collapsed quote above a reply (Phase 9b M3 on the phone, M9d here) — two
 * lines of the message being answered, and the name of whoever wrote it.
 *
 * 🔒 **What it can't say is as designed as what it can.** When `quoted` is
 * absent the viewer was clipped out of that message, and the quote says
 * "Original message unavailable" with **no name** — because the author is
 * history too. Someone can join a group, post and leave again entirely inside
 * your interval gap, and `participants` lists only *current* members, so a name
 * here would be the one payload handing you a person you were never in a chat
 * with. See `messaging.md` → *The visibility rule*.
 *
 * It's also a **way into the strand**, not just a label, and that's needed
 * rather than convenient: when the root is one you were clipped out of, its
 * replies stand alone in the transcript with no root to carry a count, so
 * without this the strand would be unreachable for exactly the person whose view
 * of it is already partial.
 */
function QuotedMessage({ quoted, onFill, onOpenThread }) {
  // Plain text, so the markup is dropped rather than drawn (M9b's parser): a
  // quote is a *reference* to a message, not a second rendering of it.
  const body = quoted?.is_deleted
    ? "Message deleted"
    : quoted
      ? plainMessageText(quoted.text)
      : "Original message unavailable";

  const content = (
    <>
      {quoted && (
        <span
          className={`block truncate text-[0.7rem] font-semibold ${
            onFill ? "text-white/85" : "text-accent-deep"
          }`}
        >
          {quoted.sender.display_name}
        </span>
      )}
      {/* Two lines and no more — `line-clamp` rather than a JS truncation, so a
          long quote can't push the reply itself off the bubble. */}
      <span
        className={`block line-clamp-2 text-xs ${
          onFill ? "text-white/75" : "text-ink-soft"
        } ${quoted ? "" : "italic"}`}
      >
        {body}
      </span>
    </>
  );

  const frame = `mb-1 block w-full border-l-2 pl-2 text-left ${
    onFill ? "border-white/50" : "border-line-strong"
  }`;

  // Inert when there's nothing to open — which is only ever a strand you're
  // already inside. A quote that looked clickable and wasn't would be worse
  // than one that plainly isn't.
  if (!onOpenThread) return <span className={frame}>{content}</span>;
  return (
    <button
      type="button"
      onClick={onOpenThread}
      aria-label={
        quoted
          ? `In reply to ${quoted.sender.display_name} — open thread`
          : "In reply to a message you can’t see — open thread"
      }
      className={`${frame} transition hover:opacity-80`}
    >
      {content}
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
