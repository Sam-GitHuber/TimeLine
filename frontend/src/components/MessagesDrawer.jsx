import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import Avatar from "./Avatar.jsx";
import {
  api,
  MESSAGE_POLL_MS,
  CONVERSATION_LIST_POLL_MS,
} from "../api.js";
import { useAuth } from "../auth.jsx";
import { useMessaging } from "../messaging.jsx";
import { formatRelativeTime } from "../utils.js";

// The messages drawer: a non-modal panel docked to the right edge, so a
// conversation sits *beside* your timeline instead of replacing it. There's no
// scrim and no scroll-lock on purpose — the feed underneath stays fully
// interactive, so you can read and reply without losing your place. It walks
// between three views (list → thread → new message) held in messaging context.
export default function MessagesDrawer() {
  const { isOpen, view, close } = useMessaging();
  const panelRef = useRef(null);

  // Esc closes; focus lands in the panel so keys + screen readers work. We
  // deliberately don't trap focus or set aria-modal — the rest of the page is
  // meant to stay usable (that's the whole point of the companion panel).
  useEffect(() => {
    if (!isOpen) return;
    function onKey(event) {
      if (event.key === "Escape") close();
    }
    document.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, close]);

  if (!isOpen) return null;

  return createPortal(
    <aside
      ref={panelRef}
      role="dialog"
      aria-label="Messages"
      tabIndex={-1}
      className="msg-drawer fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-line bg-surface shadow-[-14px_0_44px_-26px_rgba(28,26,22,0.4)] outline-none sm:w-[400px]"
    >
      {view === "list" && <ConversationListView />}
      {view === "thread" && <ConversationThreadView />}
      {view === "new" && <NewMessageView />}
    </aside>,
    document.body
  );
}

/* ---- Shared chrome ---------------------------------------------------------- */

// The little brand glyph (a node on the spine) — ties the private channel back
// to the public timeline's living line.
function SpineMark() {
  return (
    <svg
      width="12"
      height="16"
      viewBox="0 0 16 20"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
    >
      <line
        x1="8"
        y1="2"
        x2="8"
        y2="18"
        stroke="var(--color-spine)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="8" cy="6" r="4" fill="var(--color-accent)" />
    </svg>
  );
}

function StrokeIcon({ path, size = 20 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

function IconButton({ onClick, label, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-soft transition hover:bg-accent-tint hover:text-accent-deep"
    >
      {children}
    </button>
  );
}

// One header shape for all three views: optional back, a title area, optional
// actions, and always a close button — so the panel feels like one place.
function PanelHeader({ onBack, actions, children }) {
  const { close } = useMessaging();
  return (
    <header className="flex items-center gap-1.5 border-b border-line px-3 py-2.5">
      {onBack && (
        <IconButton onClick={onBack} label="Back">
          <StrokeIcon path="M15 5l-7 7 7 7" />
        </IconButton>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-2 pl-1">
        {children}
      </div>
      {actions}
      <IconButton onClick={close} label="Close messages">
        <StrokeIcon path="M6 6l12 12M18 6L6 18" />
      </IconButton>
    </header>
  );
}

/* ---- View: conversation list ----------------------------------------------- */

function ConversationListView() {
  const { openThread, openNew } = useMessaging();
  const { user: me } = useAuth();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["conversations"],
    queryFn: api.getConversations,
    refetchInterval: CONVERSATION_LIST_POLL_MS,
  });
  const conversations = data?.results ?? [];

  return (
    <>
      <PanelHeader
        actions={
          <IconButton onClick={openNew} label="New message">
            {/* compose / pencil */}
            <StrokeIcon path="M12 20h9 M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" />
          </IconButton>
        }
      >
        <SpineMark />
        <h2 className="truncate font-display text-lg font-bold -tracking-[0.02em] text-ink">
          Messages
        </h2>
      </PanelHeader>

      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <p className="px-5 py-10 text-center text-ink-faint">Loading…</p>
        )}
        {isError && (
          <p className="px-5 py-10 text-center text-red-600">
            {error?.message || "Couldn't load your messages."}
          </p>
        )}
        {!isLoading && !isError && conversations.length === 0 && (
          <div className="px-6 py-14 text-center text-ink-faint">
            <p className="font-medium text-ink">No conversations yet</p>
            <p className="mt-1 text-sm">
              Start one with someone you’re connected with.
            </p>
            <button
              type="button"
              onClick={openNew}
              className="btn btn-primary btn-sm mt-4"
            >
              New message
            </button>
          </div>
        )}

        {conversations.map((convo) => (
          <ConversationRow
            key={convo.id}
            convo={convo}
            me={me}
            onOpen={() => openThread(convo.id)}
          />
        ))}
      </div>
    </>
  );
}

function ConversationRow({ convo, me, onOpen }) {
  const last = convo.last_message;
  const mine = last && last.sender_id === me?.pk;
  const preview = last
    ? last.is_deleted
      ? "Message deleted"
      : last.text
    : "No messages yet";
  const unread = convo.unread_count > 0;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left transition hover:bg-accent-tint/40"
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
    </button>
  );
}

/* ---- View: a single thread -------------------------------------------------- */

function ConversationThreadView() {
  const { conversationId, openList } = useMessaging();
  const { user: me } = useAuth();
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const bodyRef = useRef(null);
  const bottomRef = useRef(null);

  const convoQuery = useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: () => api.getConversation(conversationId),
  });

  // Pull every message page (threads are short at family scale) so the newest
  // is always on screen, and poll so incoming messages appear without a reload.
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

  // Mark read on open and as new messages land, clearing the badges.
  useEffect(() => {
    if (convoQuery.isError) return;
    api.markConversationRead(conversationId).then(() => {
      queryClient.invalidateQueries({ queryKey: ["unreadMessages"] });
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    });
  }, [conversationId, messageCount, convoQuery.isError, queryClient]);

  // Keep the newest message in view (scrolls the panel body, not the page).
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

  const other = convoQuery.data?.other;
  const canSend = convoQuery.data?.can_message ?? false;

  return (
    <>
      <PanelHeader onBack={openList}>
        {convoQuery.isError ? (
          <span className="font-semibold text-ink">Conversation</span>
        ) : other ? (
          <Link
            to={`/u/${other.id}`}
            className="flex min-w-0 items-center gap-2"
            title={`View ${other.display_name}’s profile`}
          >
            <Avatar user={other} size="sm" />
            <span className="truncate font-display font-bold -tracking-[0.02em] text-ink">
              {other.display_name}
            </span>
          </Link>
        ) : (
          <span className="text-ink-faint">Loading…</span>
        )}
      </PanelHeader>

      {convoQuery.isError ? (
        <div className="flex-1 px-6 py-16 text-center text-ink-faint">
          <p className="font-medium text-ink">
            {convoQuery.error?.status === 404
              ? "This conversation isn’t available."
              : "Couldn’t load this conversation."}
          </p>
          <button
            type="button"
            onClick={openList}
            className="btn btn-ghost btn-sm mt-4"
          >
            Back to messages
          </button>
        </div>
      ) : (
        <>
          <div ref={bodyRef} className="flex-1 overflow-y-auto px-4 py-4">
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

          <div className="border-t border-line px-3 py-3">
            {canSend ? (
              <form onSubmit={handleSubmit} className="flex items-end gap-2">
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
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
                You’re no longer connected with{" "}
                {other?.display_name ?? "this person"}, so you can’t send new
                messages.
              </p>
            )}
            {sendMutation.isError && (
              <p className="mt-1 text-sm text-red-600">
                {sendMutation.error?.message || "Couldn't send. Try again."}
              </p>
            )}
          </div>
        </>
      )}
    </>
  );
}

// One message row — yours align right (filled accent), theirs left. A deleted
// message leaves a muted placeholder in its original spot.
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
    <li
      className={`msg-bubble group flex items-end gap-1.5 ${
        mine ? "justify-end" : "justify-start"
      }`}
    >
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
        className={`max-w-[78%] rounded-2xl px-3.5 py-2 ${
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

/* ---- View: start a new message --------------------------------------------- */

function NewMessageView() {
  const { openList, openThread } = useMessaging();
  const [term, setTerm] = useState("");

  // Recipients are your connections (messaging is connection-gated). The people
  // list carries connection_status, so we filter to the accepted ones.
  const { data, isLoading, isError } = useQuery({
    queryKey: ["users"],
    queryFn: api.listUsers,
  });
  const connections = (data?.results ?? []).filter(
    (u) => u.connection_status === "connected"
  );
  const needle = term.trim().toLowerCase();
  const filtered = needle
    ? connections.filter((u) =>
        u.display_name.toLowerCase().includes(needle)
      )
    : connections;

  const open = useMutation({
    mutationFn: (userId) => api.openConversation(userId),
    onSuccess: (conversation) => openThread(conversation.id),
  });

  return (
    <>
      <PanelHeader onBack={openList}>
        <h2 className="truncate font-display text-lg font-bold -tracking-[0.02em] text-ink">
          New message
        </h2>
      </PanelHeader>

      <div className="border-b border-line px-3 py-2.5">
        <input
          type="search"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search your connections…"
          aria-label="Search your connections"
          className="w-full rounded-xl border border-line-strong bg-raised px-3.5 py-2 text-sm text-ink transition placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-tint"
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <p className="px-5 py-10 text-center text-ink-faint">Loading…</p>
        )}
        {isError && (
          <p className="px-5 py-10 text-center text-red-600">
            Couldn’t load your connections.
          </p>
        )}
        {!isLoading && !isError && connections.length === 0 && (
          <div className="px-6 py-12 text-center text-ink-faint">
            <p className="font-medium text-ink">No connections yet</p>
            <p className="mt-1 text-sm">
              You can only message people you’re connected with. Find people to
              connect with first.
            </p>
          </div>
        )}
        {!isLoading &&
          connections.length > 0 &&
          filtered.length === 0 && (
            <p className="px-5 py-10 text-center text-ink-faint">
              No connections match “{term}”.
            </p>
          )}

        {filtered.map((person) => (
          <button
            key={person.id}
            type="button"
            onClick={() => open.mutate(person.id)}
            disabled={open.isPending}
            className="flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left transition hover:bg-accent-tint/40 disabled:opacity-60"
          >
            <Avatar user={person} size="md" />
            <span className="min-w-0 flex-1 truncate font-semibold text-ink">
              {person.display_name}
            </span>
          </button>
        ))}
      </div>

      {open.isError && (
        <p className="border-t border-line px-4 py-2 text-sm text-red-600">
          {open.error?.message || "Couldn’t open that conversation."}
        </p>
      )}
    </>
  );
}
