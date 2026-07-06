import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import Avatar from "../components/Avatar.jsx";
import { api, MESSAGE_POLL_MS } from "../api.js";
import { useAuth } from "../auth.jsx";
import { formatRelativeTime } from "../utils.js";

// A single conversation thread: the other person in the header, the messages
// oldest-first, and a box to send a new one. Near-real-time by polling (no
// WebSockets yet — see the Phase 5 doc); the swap to a socket later replaces the
// interval and nothing else.
export default function ConversationPage() {
  const { id } = useParams();
  const conversationId = Number(id);
  const { user: me } = useAuth();
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const bottomRef = useRef(null);

  // Header: who you're talking to. Its own query so a cold load/refresh still
  // knows the other person (the messages endpoint doesn't carry them).
  const convoQuery = useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: () => api.getConversation(conversationId),
  });

  // Messages oldest-first, paginated. We eagerly pull every page (threads are
  // short at family scale) so the newest messages are always on screen, and
  // poll so incoming messages appear without a reload.
  const messagesQuery = useInfiniteQuery({
    queryKey: ["messages", conversationId],
    queryFn: ({ pageParam }) =>
      pageParam ? api.getPage(pageParam) : api.getMessages(conversationId),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
    refetchInterval: MESSAGE_POLL_MS,
  });
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = messagesQuery;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const messages =
    messagesQuery.data?.pages.flatMap((page) => page.results) ?? [];
  const messageCount = messages.length;

  // Mark the thread read whenever new messages land (and on open), so the unread
  // badge clears. Invalidate the nav badge + list so they reflect it.
  useEffect(() => {
    if (convoQuery.isError) return;
    api.markConversationRead(conversationId).then(() => {
      queryClient.invalidateQueries({ queryKey: ["unreadMessages"] });
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    });
  }, [conversationId, messageCount, convoQuery.isError, queryClient]);

  // Keep the newest message in view as the thread grows / a message is sent.
  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ block: "end" });
  }, [messageCount]);

  const sendMutation = useMutation({
    mutationFn: (value) => api.sendMessage(conversationId, value),
    onSuccess: () => {
      setText("");
      queryClient.invalidateQueries({ queryKey: ["messages", conversationId] });
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (messageId) => api.deleteMessage(conversationId, messageId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["messages", conversationId] });
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });

  function handleSubmit(event) {
    event.preventDefault();
    const value = text.trim();
    if (!value || sendMutation.isPending) return;
    sendMutation.mutate(value);
  }

  if (convoQuery.isError) {
    const notFound = convoQuery.error?.status === 404;
    return (
      <div className="px-6 py-16 text-center">
        <p className="text-lg font-medium text-ink">
          {notFound ? "Conversation not found" : "Couldn't load this conversation"}
        </p>
        <Link
          to="/messages"
          className="mt-4 inline-block font-medium text-accent-deep hover:underline"
        >
          ← Back to messages
        </Link>
      </div>
    );
  }

  const other = convoQuery.data?.other;
  // Messaging is connection-gated: if you've disconnected (or been blocked) the
  // history stays readable but you can't send. `can_message` is computed
  // server-side to match the real send gate (which still 403s regardless).
  const canSend = convoQuery.data?.can_message ?? false;

  return (
    <div className="flex min-h-[calc(100vh-58px)] flex-col">
      <header className="sticky top-[57px] z-10 flex items-center gap-3 border-b border-line bg-surface/90 px-5 py-3 backdrop-blur">
        <Link
          to="/messages"
          className="text-ink-faint transition hover:text-ink"
          aria-label="Back to messages"
        >
          ←
        </Link>
        {other && (
          <Link
            to={`/u/${other.id}`}
            className="flex min-w-0 items-center gap-2.5"
          >
            <Avatar user={other} size="sm" />
            <span className="truncate font-display font-bold -tracking-[0.02em] text-ink">
              {other.display_name}
            </span>
          </Link>
        )}
      </header>

      <div className="flex-1 px-5 py-4">
        {messagesQuery.isLoading ? (
          <p className="py-10 text-center text-ink-faint">Loading…</p>
        ) : messages.length === 0 ? (
          <p className="py-10 text-center text-ink-faint">
            No messages yet — say hello.
          </p>
        ) : (
          <ul className="space-y-2">
            {messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                mine={message.sender.id === me?.pk}
                onDelete={() => deleteMutation.mutate(message.id)}
                deleting={deleteMutation.isPending}
              />
            ))}
          </ul>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="sticky bottom-0 border-t border-line bg-surface/90 px-5 py-3 backdrop-blur">
        {canSend ? (
          <form onSubmit={handleSubmit} className="flex items-end gap-2">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends; Shift+Enter makes a newline.
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(e);
                }
              }}
              rows={1}
              placeholder="Write a message…"
              className="max-h-32 flex-1 resize-none rounded-2xl border border-line-strong bg-raised px-4 py-2.5 text-base text-ink transition placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-tint"
            />
            <button
              type="submit"
              disabled={!text.trim() || sendMutation.isPending}
              className="btn btn-primary btn-sm mb-0.5"
            >
              {sendMutation.isPending ? "Sending…" : "Send"}
            </button>
          </form>
        ) : (
          <p className="py-1 text-center text-sm text-ink-faint">
            You’re no longer connected with {other?.display_name ?? "this person"},
            so you can’t send new messages.
          </p>
        )}
        {sendMutation.isError && (
          <p className="mt-1 text-sm text-red-600">
            {sendMutation.error?.message || "Couldn't send. Try again."}
          </p>
        )}
      </div>
    </div>
  );
}

// One message row — your own align right (accent), theirs left. A soft-deleted
// message shows a muted "message deleted" placeholder in its original spot. You
// can delete your own (not-yet-deleted) message via a small control on hover.
function MessageBubble({ message, mine, onDelete, deleting }) {
  if (message.is_deleted) {
    return (
      <li className={`flex ${mine ? "justify-end" : "justify-start"}`}>
        <span className="rounded-2xl bg-ink/[0.03] px-3.5 py-2 text-sm italic text-ink-faint">
          Message deleted
        </span>
      </li>
    );
  }

  return (
    <li className={`group flex items-end gap-1.5 ${mine ? "justify-end" : "justify-start"}`}>
      {mine && (
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
      <div
        className={`max-w-[75%] rounded-2xl px-3.5 py-2 ${
          mine
            ? "bg-accent text-white"
            : "bg-raised text-ink ring-1 ring-line"
        }`}
      >
        <p className="whitespace-pre-wrap break-words text-[0.95rem]">
          {message.text}
        </p>
        <span
          className={`mt-0.5 block font-mono text-[0.65rem] ${
            mine ? "text-white/70" : "text-ink-faint"
          }`}
          title={message.created_at}
        >
          {formatRelativeTime(message.created_at)}
        </span>
      </div>
    </li>
  );
}
