import Avatar from "../Avatar.jsx";
import { formatRelativeTime } from "../../utils.js";

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
export default function MessageBubble({ message, mine, showSender, onDelete, deleting }) {
  return (
    <li className={`${message.is_deleted ? "" : "msg-bubble"} group flex flex-col`}>
      {showSender && (
        <span className="mb-1 flex items-center gap-1.5">
          <Avatar user={message.sender} size="xs" />
          <span className="truncate text-xs font-medium text-ink-soft">
            {message.sender.display_name}
          </span>
        </span>
      )}

      <div
        className={`flex items-end gap-1.5 ${
          mine ? "justify-end" : "justify-start"
        }`}
      >
        {mine && !message.is_deleted && (
          <button
            type="button"
            onClick={onDelete}
            disabled={deleting}
            aria-label="Delete message"
            className="mb-1 text-xs text-ink-faint opacity-0 transition group-hover:opacity-100 hover:text-red-600"
          >
            Delete
          </button>
        )}
        {message.is_deleted ? (
          <span className="rounded-2xl bg-ink/[0.03] px-3.5 py-2 text-sm italic text-ink-faint">
            Message deleted
          </span>
        ) : (
          <div
            className={`max-w-[78%] rounded-2xl px-3.5 py-2 ${
              mine
                ? "bg-accent text-white"
                : "bg-raised text-ink ring-1 ring-line"
            }`}
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
            {(message.attachments ?? []).map((attachment) => (
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
              <p className="whitespace-pre-wrap break-words text-[0.95rem]">
                {message.text}
              </p>
            )}
            <span
              className={`mt-0.5 block font-mono text-[0.65rem] ${
                mine ? "text-white/70" : "text-ink-faint"
              }`}
              title={message.created_at}
            >
              {formatRelativeTime(message.created_at)}
            </span>
          </div>
        )}
      </div>
    </li>
  );
}
