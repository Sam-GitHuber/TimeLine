import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import Avatar from "../Avatar.jsx";
import { StrokeIcon, IconButton, PanelHeader } from "../drawer-chrome.jsx";
import PendingChatPanel from "../PendingChatPanel.jsx";
import AvatarStack from "./AvatarStack.jsx";
import MessageBubble from "./MessageBubble.jsx";
import { api, MESSAGE_POLL_MS } from "../../api.js";
import { useAuth } from "../../auth.jsx";
import { useMessaging } from "../../messaging.jsx";

// One conversation: header identity + actions, the transcript, and the
// composer. A `pending` viewer gets PendingChatPanel instead of the transcript —
// they can't read or send here yet.
export default function ConversationThreadView() {
  const { conversationId, openList, openNew } = useMessaging();
  const { user: me } = useAuth();
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const bottomRef = useRef(null);

  const convoQuery = useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: () => api.getConversation(conversationId),
  });

  const detail = convoQuery.data;
  const isGroup = detail?.kind === "group";
  // A pending group member (someone invited who hasn't connected with the
  // whole clique yet) can't read or send here — the backend 403s the messages
  // endpoint — so the thread is replaced by PendingChatPanel below instead of
  // fetching a list it can't have.
  const isPending = detail?.my_status === "pending";

  // Pull every message page (threads are short at family scale) so the newest
  // is always on screen, and poll so incoming messages appear without a reload.
  const messagesQuery = useInfiniteQuery({
    queryKey: ["messages", conversationId],
    queryFn: ({ pageParam }) =>
      pageParam ? api.getPage(pageParam) : api.getMessages(conversationId),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
    refetchInterval: MESSAGE_POLL_MS,
    enabled: !!detail && !isPending,
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

  // Leave (or, while pending, decline) a chat — group-only in the header;
  // PendingChatPanel has its own copy of this for the locked view.
  const leaveMutation = useMutation({
    mutationFn: () => api.leaveConversation(conversationId),
    onSuccess: () => openList(),
  });

  // Silence this thread's *push* notifications (issue #118). Offered on the web
  // even though the web has no push of its own: the setting is per-participant
  // and server-side, so this is where someone at a desk turns off the buzzing in
  // their pocket. Mute never hides the thread or its unread count.
  const muteMutation = useMutation({
    mutationFn: (muted) => api.setConversationMuted(conversationId, muted),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });

  function handleSubmit(event) {
    event.preventDefault();
    const value = text.trim();
    if (!value || sendMutation.isPending) return;
    sendMutation.mutate(value);
  }

  const other = detail?.other;
  const participants = detail?.participants ?? [];
  // Renamed from Phase 5's `can_message` — see ConversationSerializer.
  const canSend = detail?.can_send ?? false;

  return (
    <>
      <PanelHeader
        onBack={openList}
        actions={
          !convoQuery.isError &&
          !isPending &&
          detail && (
            <>
              {/* Mute is offered on every thread, direct or group — unlike Add
                  and Leave below, which are group-only. A bell, struck through
                  when muted, so the state reads at a glance. */}
              <IconButton
                onClick={() => muteMutation.mutate(!detail.muted)}
                label={
                  detail.muted ? "Unmute notifications" : "Mute notifications"
                }
                pressed={detail.muted}
              >
                <StrokeIcon
                  path={
                    detail.muted
                      ? "M18 8a6 6 0 00-9.33-5 M6.26 6.26A6 6 0 006 8c0 7-3 9-3 9h14 M13.73 21a2 2 0 01-3.46 0 M2 2l20 20"
                      : "M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9 M13.73 21a2 2 0 01-3.46 0"
                  }
                />
              </IconButton>
              {isGroup && (
                <>
                  <IconButton
                    onClick={() =>
                      openNew({ addToConversationId: conversationId })
                    }
                    label="Add people"
                  >
                    <StrokeIcon path="M16 19v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2 M9 11a4 4 0 100-8 4 4 0 000 8z M19 8v6 M22 11h-6" />
                  </IconButton>
                  <IconButton
                    onClick={() => leaveMutation.mutate()}
                    label="Leave chat"
                  >
                    <StrokeIcon path="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4 M16 17l5-5-5-5 M21 12H9" />
                  </IconButton>
                </>
              )}
            </>
          )
        }
      >
        {convoQuery.isError ? (
          <span className="font-semibold text-ink">Conversation</span>
        ) : isGroup ? (
          <div className="flex min-w-0 items-center gap-2">
            <AvatarStack participants={participants} />
            <span className="truncate font-display font-bold -tracking-[0.02em] text-ink">
              {detail.title || "Group chat"}
            </span>
          </div>
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
      ) : isPending ? (
        <PendingChatPanel
          mustConnectWith={detail.must_connect_with}
          conversationId={conversationId}
        />
      ) : (
        <>
          <div className="flex-1 overflow-y-auto px-4 py-4">
            {messagesQuery.isLoading ? (
              <p className="py-10 text-center text-ink-faint">Loading…</p>
            ) : messages.length === 0 ? (
              <p className="py-10 text-center text-ink-faint">
                No messages yet — say hello.
              </p>
            ) : (
              <ul className="space-y-2">
                {messages.map((message, index) => {
                  const mine = message.sender.id === me?.pk;
                  // A run = consecutive messages from one sender. Only the
                  // run's first bubble is attributed, so a burst of messages
                  // reads as one block instead of repeating the name on every
                  // line.
                  const startsRun =
                    messages[index - 1]?.sender.id !== message.sender.id;
                  return (
                    <MessageBubble
                      key={message.id}
                      message={message}
                      mine={mine}
                      showSender={isGroup && !mine && startsRun}
                      onDelete={() => deleteMutation.mutate(message.id)}
                      deleting={deleteMutation.isPending}
                    />
                  );
                })}
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
