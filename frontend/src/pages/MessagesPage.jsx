import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import Avatar from "../components/Avatar.jsx";
import { api, CONVERSATION_LIST_POLL_MS } from "../api.js";
import { useAuth } from "../auth.jsx";
import { formatRelativeTime } from "../utils.js";

// Your conversations, most-recent-activity first (time, never "relevance").
// Each row shows the other person, a preview of the last message, when it
// happened, and — if you have unread messages — a count badge. Polled on a slow
// interval so it stays current without WebSockets (see the Phase 5 doc).
export default function MessagesPage() {
  const { user: me } = useAuth();

  // Not paginated with "Load more" here: a family-scale account has few
  // conversations, and polling wants the first page anyway. The first page is
  // plenty; if this ever grows we'd switch to useInfiniteList like the feed.
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["conversations"],
    queryFn: api.getConversations,
    refetchInterval: CONVERSATION_LIST_POLL_MS,
  });
  const conversations = data?.results ?? [];

  return (
    <div>
      <h1 className="border-b border-line px-5 py-4 font-display text-lg font-bold -tracking-[0.02em] text-ink">
        Messages
      </h1>

      {isLoading && (
        <p className="px-6 py-10 text-center text-ink-faint">Loading…</p>
      )}

      {isError && (
        <p className="px-6 py-10 text-center text-red-600">
          {error?.message || "Couldn't load your messages."}
        </p>
      )}

      {!isLoading && !isError && conversations.length === 0 && (
        <div className="px-6 py-14 text-center text-ink-faint">
          <p className="font-medium text-ink">No messages yet.</p>
          <p className="mt-1">
            Open a connection's profile and hit{" "}
            <span className="font-medium">Message</span> to start a
            conversation.
          </p>
        </div>
      )}

      {conversations.map((convo) => {
        const last = convo.last_message;
        // Whose message the preview is: "You: …" for your own.
        const mine = last && last.sender_id === me?.pk;
        const preview = last
          ? last.is_deleted
            ? "Message deleted"
            : last.text
          : "No messages yet";
        const unread = convo.unread_count > 0;

        return (
          <Link
            key={convo.id}
            to={`/messages/${convo.id}`}
            className="flex items-center gap-3 border-b border-line px-5 py-3.5 transition hover:bg-accent-tint/40"
          >
            <Avatar user={convo.other} size="md" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-semibold text-ink">
                  {convo.other.display_name}
                </span>
                <span className="shrink-0 font-mono text-xs text-ink-faint">
                  {formatRelativeTime(convo.updated_at)}
                </span>
              </div>
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
            </div>
            {unread && (
              <span className="inline-flex min-w-[20px] shrink-0 items-center justify-center rounded-full bg-accent px-1.5 text-[0.68rem] font-bold tabular-nums text-white">
                {convo.unread_count}
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}
