import { useMemo } from "react";
import Avatar from "../Avatar.jsx";
import { StrokeIcon } from "../drawer-chrome.jsx";
import AvatarStack from "./AvatarStack.jsx";
import DrawerMenu from "./DrawerMenu.jsx";
import { plainMessageText } from "../../messageText.js";
import { formatRelativeTime } from "../../utils.js";

// One row in the conversation list: who it's with, the last thing said, and how
// many messages are waiting. Relative time is right *here* (the question is how
// recent something is) even though the transcript uses clock times — see
// reference/messaging.md.
//
// Phase 9b M9e added the `⋯` (Mute · Mark unread · Leave). It's a **sibling** of
// the row's own button rather than inside it: a button can't nest a button, and
// the version that tried it rendered a menu whose every click also opened the
// chat it was about.
export default function ConversationRow({ convo, me, onOpen, getActions }) {
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
  // Memoised for the reason the bubble's parse is: stripping the markup means
  // running the parser, and the parser has a quadratic worst case on a string
  // full of delimiters that never close. The list re-renders on every poll, so
  // paying that per render would let one awkward message make it stutter.
  const body = useMemo(() => (last?.text ? plainMessageText(last.text) : ""), [last]);
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

  const name = isGroup
    ? groupName || "Group chat"
    : convo.other.display_name;

  return (
    // `group` is what reveals the `⋯` on hover (`msg-menu-trigger`, index.css).
    // `pr-1` rather than the row's own padding on the right, because the trigger
    // brings its own — otherwise the menu sits a thumb's width off the edge.
    <div className="group flex w-full items-center gap-3 border-b border-line py-3 pl-4 pr-1 transition hover:bg-accent-tint/40">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open conversation with ${name}`}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        {isGroup ? (
          <AvatarStack participants={participants} max={3} />
        ) : (
          <Avatar user={convo.other} size="md" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate font-semibold text-ink">{name}</span>
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
              className={`flex items-center gap-1 truncate text-sm ${
                unread ? "font-medium text-ink" : "text-ink-soft"
              }`}
            >
              {/* A muted thread says so on its row, because the whole risk of
                  muting is forgetting you did — and the row is where you'd
                  wonder why a chat has gone quiet. */}
              {convo.muted && (
                <StrokeIcon
                  path="M18 8a6 6 0 00-9.33-5 M6.26 6.26A6 6 0 006 8c0 7-3 9-3 9h14 M13.73 21a2 2 0 01-3.46 0 M2 2l20 20"
                  size={13}
                />
              )}
              <span className="truncate">
                {mine && !last.is_deleted && (
                  <span className="text-ink-faint">You: </span>
                )}
                {preview}
              </span>
            </p>
          )}
        </div>
        {!isPending && unread && (
          <span className="inline-flex min-w-[20px] shrink-0 items-center justify-center rounded-full bg-accent px-1.5 text-[0.68rem] font-bold tabular-nums text-white">
            {/* Three digits would stretch the pill past the preview it sits
                beside; past a hundred the exact number isn't the point. */}
            {convo.unread_count > 99 ? "99+" : convo.unread_count}
          </span>
        )}
      </button>

      {getActions && (
        <DrawerMenu
          getActions={getActions}
          label={`Options for ${name}`}
          onHover
        />
      )}
    </div>
  );
}
