import Avatar from "../Avatar.jsx";
import MessageMenu from "./MessageMenu.jsx";
import MessageText from "./MessageText.jsx";
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
// Delete.
export default function MessageBubble({
  message,
  mine,
  showSender,
  startsRun = true,
  endsRun = true,
  getActions,
}) {
  /**
   * The timestamp is shown on the run's **last** bubble only. Five messages sent
   * in one minute don't each need the same clock time standing where the next
   * message should be.
   *
   * One exception, and it's load-bearing rather than a tidy-up: an **"Edited"**
   * marker is a *disclosure* — `messaging.md` calls it the thing that makes
   * editing safe at all — so it can't be suppressed by where a bubble happens to
   * sit in a run.
   */
  const showMeta = endsRun || message.is_edited;
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
      className={`${message.is_deleted ? "" : "msg-bubble"} group flex flex-col ${
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

      <div
        className={`flex items-end gap-1 ${
          mine ? "justify-end" : "justify-start"
        }`}
      >
        {/* No menu on a tombstone: there's nothing left to act on. The trigger
            sits on the far side of the bubble from the panel edge so it never
            covers the text it belongs to. */}
        {!message.is_deleted && getActions && (
          <MessageMenu getActions={() => getActions(message)} mine={mine} />
        )}
        {message.is_deleted ? (
          <span className="rounded-2xl bg-ink/[0.03] px-3.5 py-2 text-sm italic text-ink-faint">
            Message deleted
          </span>
        ) : (
          <div
            className={
              large
                ? "max-w-[78%]"
                : `max-w-[78%] rounded-2xl px-3.5 py-2 ${
                    mine
                      ? "bg-accent text-white"
                      : "bg-raised text-ink ring-1 ring-line"
                  }`
            }
          >
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
              <span
                className={`mt-0.5 block font-mono text-[0.65rem] ${
                  large
                    ? "text-ink-faint"
                    : mine
                      ? "text-white/70"
                      : "text-ink-faint"
                }`}
                title={message.created_at}
              >
                {clock.time}
                {clock.meridiem}
                {/* An edit is disclosed, never silent: a thread is a shared
                    record, and quietly changing what someone already read would
                    make it worthless as one. */}
                {message.is_edited ? " · Edited" : ""}
              </span>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
