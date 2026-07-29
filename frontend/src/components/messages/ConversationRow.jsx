import Avatar from "../Avatar.jsx";
import { StrokeIcon } from "../drawer-chrome.jsx";
import AvatarStack from "./AvatarStack.jsx";
import { plainMessageText } from "../../messageText.js";
import { formatRelativeTime } from "../../utils.js";

// One row in the conversation list: who it's with, the last thing said, and how
// many messages are waiting. Relative time is right *here* (the question is how
// recent something is) even though the transcript uses clock times — see
// reference/messaging.md.
export default function ConversationRow({ convo, me, onOpen }) {
  const isGroup = convo.kind === "group";
  const isPending = convo.my_status === "pending";
  const last = convo.last_message;
  const mine = last && last.sender_id === me?.pk;
  // A photo message may carry no caption at all (Phase 9b M7), which would
  // render as a blank line where the preview goes. Same phrasing as the app's.
  const photos = last?.attachment_count ?? 0;
  // A preview is one line of plain text, so it drops the markup rather than
  // showing the raw `*asterisks*` the bubble two inches away renders as bold
  // (Phase 9b M9b). Leaving them here was the "half-finished" seam
  // `plainMessageText` exists to close.
  const body = last?.text ? plainMessageText(last.text) : "";
  const preview = last
    ? last.is_deleted
      ? "Message deleted"
      : photos > 0
        ? `📷 ${body || "Photo"}`
        : body
    : "No messages yet";
  const unread = convo.unread_count > 0;

  // A group with no title falls back to a comma-joined list of its
  // participants' names, same idea as NewChatPicker's untitled-group preview.
  // `participants` includes the viewer themselves, so exclude `me` from the
  // fallback name — otherwise an untitled group renders as "You, Priya, Sanjay".
  const participants = convo.participants ?? [];
  const groupName =
    convo.title ||
    participants
      .filter((person) => person.id !== me?.pk)
      .map((person) => person.display_name)
      .join(", ");

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left transition hover:bg-accent-tint/40"
    >
      {isGroup ? (
        <AvatarStack participants={participants} max={3} />
      ) : (
        <Avatar user={convo.other} size="md" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate font-semibold text-ink">
            {isGroup ? groupName || "Group chat" : convo.other.display_name}
          </span>
          <span className="shrink-0 font-mono text-xs text-ink-faint">
            {formatRelativeTime(convo.updated_at)}
          </span>
        </div>
        {isPending ? (
          <p className="flex items-center gap-1 truncate text-sm text-ink-faint">
            <StrokeIcon
              path="M7 11V7a5 5 0 0110 0v4 M5 11h14v9a1 1 0 01-1 1H6a1 1 0 01-1-1z"
              size={14}
            />
            Invited — connect to join
          </p>
        ) : (
          <p
            className={`truncate text-sm ${
              unread ? "font-medium text-ink" : "text-ink-soft"
            }`}
          >
            {mine && !last.is_deleted && (
              <span className="text-ink-faint">You: </span>
            )}
            {preview}
          </p>
        )}
      </div>
      {!isPending && unread && (
        <span className="inline-flex min-w-[20px] shrink-0 items-center justify-center rounded-full bg-accent px-1.5 text-[0.68rem] font-bold tabular-nums text-white">
          {convo.unread_count}
        </span>
      )}
    </button>
  );
}
