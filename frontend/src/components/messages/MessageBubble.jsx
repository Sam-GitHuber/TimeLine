import { useRef, useState } from "react";
import Avatar from "../Avatar.jsx";
import DrawerPopover from "./DrawerPopover.jsx";
import MessageMenu from "./MessageMenu.jsx";
import MessageText from "./MessageText.jsx";
import ReactorsPopover from "../ReactorsPopover.jsx";
import { isEmojiOnly } from "../../messageText.js";
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
export default function MessageBubble({
  message,
  mine,
  showSender,
  startsRun = true,
  endsRun = true,
  getActions,
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
                ? "max-w-[78%]"
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
            {/* Photos (Phase 9b M7). **A deliberate stopgap, not the finished
                treatment** — M9e ports the app's version (a sized bubble that
                doesn't reflow as it loads, opening in the shared `Lightbox`).
                What this fixes now is worse than an unpolished photo: the app
                can send a caption-less photo message today, and without this the
                web renders it as an empty bubble, which reads as a bug in the
                other person's message. A thumbnail that opens the full image in
                a tab is honest and ten lines.

                No auth plumbing needed here, unlike the app: `/media/*` is
                cookie-gated (Caddy `forward_auth`) and a browser attaches the
                cookie to an <img> request by itself. */}
            {photos.map((attachment) => (
              <a
                key={attachment.id}
                href={attachment.url}
                target="_blank"
                rel="noreferrer"
                className="mb-1 block"
              >
                <img
                  src={attachment.thumbnail}
                  width={attachment.width}
                  height={attachment.height}
                  alt="Photo"
                  className="max-h-64 w-auto rounded-xl"
                />
              </a>
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
