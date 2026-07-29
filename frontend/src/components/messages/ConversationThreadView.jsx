import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import Avatar from "../Avatar.jsx";
import LoadMoreButton from "../LoadMoreButton.jsx";
import { StrokeIcon, IconButton, PanelHeader } from "../drawer-chrome.jsx";
import PendingChatPanel from "../PendingChatPanel.jsx";
import { ReportModal } from "../ReportButton.jsx";
import AvatarStack from "./AvatarStack.jsx";
import MessageBubble from "./MessageBubble.jsx";
import { DaySeparator, UnreadDivider } from "./ThreadDividers.jsx";
import { api, MESSAGE_EDIT_WINDOW_MS, MESSAGE_POLL_MS } from "../../api.js";
import { useAuth } from "../../auth.jsx";
import { getDraft, setDraft } from "../../drafts.js";
import { useDayBoundary } from "../../hooks.js";
import { useMessaging } from "../../messaging.jsx";
import { firstUnreadId, toThreadRows } from "../../threadRows.js";

// How far from the newest message counts as "scrolled away", in px — the point
// at which jump-to-latest appears.
const JUMP_THRESHOLD = 200;
// How close to the top of the loaded history a scroll gets before the next page
// of older messages is fetched.
const OLDER_THRESHOLD = 300;

/**
 * What the ⋯ menu offers for one message (Phase 9b M9b).
 *
 * A plain function of its inputs — `now` is passed in, not read — so the list is
 * decided when the menu opens rather than when React last redrew the bubble.
 * Edit expires fifteen minutes after sending, and a menu whose contents depend
 * on render timing is the kind of bug nobody reproduces.
 *
 * **Data, not JSX**, deliberately: M9c slots React in, M9d Reply, M9f Select.
 *
 * Edit appears only on your own message, only inside the edit window, and only
 * while you can still send here. The server enforces all three independently
 * ([`messaging.md`](../../../../docs/reference/messaging.md) → *Editing a
 * message*); this only avoids offering an action that would come back 403.
 */
function messageActions({
  message,
  mine,
  canSend,
  now,
  onEdit,
  onDelete,
  onReport,
}) {
  const actions = [
    {
      label: "Copy",
      // Swallow a clipboard failure: there's nothing useful to tell someone
      // whose copy didn't take, and an unhandled rejection is a console error.
      // `?.` because a browser without a secure context has no clipboard API at
      // all, and neither does jsdom.
      onClick: () => {
        navigator.clipboard?.writeText?.(message.text)?.catch?.(() => {});
      },
    },
  ];
  if (mine) {
    const age = now - new Date(message.created_at).getTime();
    if (canSend && age < MESSAGE_EDIT_WINDOW_MS) {
      actions.push({ label: "Edit", onClick: () => onEdit(message) });
    }
    actions.push({
      label: "Delete",
      danger: true,
      onClick: () => onDelete(message.id),
    });
  } else {
    actions.push({ label: "Report", onClick: () => onReport(message.id) });
  }
  return actions;
}

// One conversation: header identity + actions, the transcript, and the
// composer. A `pending` viewer gets PendingChatPanel instead of the transcript —
// they can't read or send here yet.
//
// Phase 9b M9b rebuilt the transcript on the shape the app has had since M5: one
// page on open with older messages paging in as you scroll back, day separators
// and clock times, run grouping, a latched unread divider the thread opens at,
// jump-to-latest, per-conversation drafts, and the ⋯ menu (Copy · Edit · Delete
// on your own, Copy · Report on someone else's) that replaced the inline Delete.
export default function ConversationThreadView() {
  const { conversationId, openList, openNew } = useMessaging();
  const { user: me } = useAuth();
  const queryClient = useQueryClient();
  /**
   * Seeded from the draft store, so a half-written message survives leaving the
   * thread and coming back. It used to die with the view, which made "go and
   * check what they said in the other chat" a way to silently lose your words.
   */
  const [text, setText] = useState(() => getDraft(conversationId));
  // The message being corrected, if any — the composer doubles as the editor.
  const [editing, setEditing] = useState(null);
  // Whatever was half-typed when edit mode started, put back on cancel. Losing a
  // draft to a typo fix would be its own small betrayal.
  const [stashedDraft, setStashedDraft] = useState("");
  const [reportingId, setReportingId] = useState(null);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

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

  /**
   * The thread, **newest page first** and paged lazily.
   *
   * This view used to walk `fetchNextPage` in an effect until every page was in
   * memory, so opening a chat pulled its entire history — invisible at family
   * scale and worse every month. That wasn't laziness: the endpoint's default
   * order is oldest-first, which puts the newest messages on the *last* page, so
   * "show me the bottom of this chat" genuinely meant loading all of it.
   * `getMessages` now asks for `?order=desc`, which makes page one the screenful
   * you open to and lets `loadOlder` page backwards as you scroll up.
   */
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
  const loadOlder = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const pages = messagesQuery.data;
  const messages = useMemo(
    () => pages?.pages.flatMap((page) => page.results) ?? [],
    [pages]
  );
  const messageCount = messages.length;

  /**
   * How many messages were waiting when you opened the thread — captured
   * **once**, because the mark-read effect below moves the marker a moment later
   * and the divider has to outlive that.
   *
   * Latched **during render**, which is React's own "adjust state while
   * rendering" pattern rather than a shortcut past an effect: the mark-read POST
   * goes out in an effect, so the count must be taken before anything
   * asynchronous can zero it — which is also why that effect waits for the
   * detail, since if the write won the race there'd be nothing left to capture.
   *
   * Taken from `unread_count` rather than your own `last_read_at`, which the
   * payload withholds entirely when you've turned read receipts off — see
   * `firstUnreadId`.
   */
  const [unreadOnOpen, setUnreadOnOpen] = useState(null);
  if (unreadOnOpen === null && detail) {
    setUnreadOnOpen(detail.unread_count ?? 0);
  }
  /**
   * Which message the divider sits above — latched the *first time it can be
   * worked out*, and never recomputed after.
   *
   * **The count alone isn't enough to hold it still.** `firstUnreadId` counts
   * back from the newest message, and the newest message keeps changing: every
   * message that arrives while you're reading pushes a fixed count one further
   * down, so a live re-derivation slides the divider past the very messages it
   * was placed to mark. Staying `null` is deliberate and stays live — it means
   * the unread run is longer than what has loaded, which resolves itself as
   * pages come in.
   */
  const [unreadFrom, setUnreadFrom] = useState(null);
  if (unreadFrom === null && unreadOnOpen) {
    const anchor = firstUnreadId(messages, unreadOnOpen, me?.pk);
    if (anchor !== null) setUnreadFrom(anchor);
  }
  const unread = useMemo(
    () =>
      unreadFrom !== null && unreadOnOpen
        ? { fromId: unreadFrom, count: unreadOnOpen }
        : null,
    [unreadFrom, unreadOnOpen]
  );

  /**
   * The transcript's rows, newest-first — which is what the `column-reverse`
   * scroller below wants, and the same order the app's inverted list reads in.
   *
   * `today` is a dependency, not a value used directly: it changes at local
   * midnight, the one moment "Today" and "Yesterday" go stale with no data
   * having changed.
   */
  const today = useDayBoundary();
  const rows = useMemo(
    () => toThreadRows({ messages, meId: me?.pk, unread }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see `today` above
    [messages, me?.pk, unread, today]
  );

  /**
   * Open the thread **at the unread divider**, not at the bottom.
   *
   * This is what the divider is *for*. A marker you have to go and find is a
   * decoration; a thread that opens where you stopped reading is what makes
   * coming back to twenty messages tractable. Once only — the rows are rebuilt
   * on every four-second poll, and re-running this would yank the list back up
   * under someone who had scrolled away. After that, jump-to-latest (which the
   * scroll itself brings up) is how you get to the bottom, which is the right
   * way round: the newest message is one click away and the one you left off at
   * is already on screen.
   */
  const openedAtUnread = useRef(false);
  const unreadRef = useCallback((node) => {
    if (!node || openedAtUnread.current) return;
    openedAtUnread.current = true;
    // `block: "start"` is the visual top even in a column-reverse scroller —
    // scrolling is done in visual coordinates, not flex order. Optional call
    // because jsdom has no layout and so no `scrollIntoView`.
    node.scrollIntoView?.({ block: "start" });
  }, []);

  /**
   * Jump-to-latest — the floating control that appears once you've scrolled up,
   * carrying a count of what has arrived since.
   *
   * The count is what makes it worth having. A bare arrow is a scroll shortcut;
   * "3 new" is the thing that tells you to take it, and it's the only way to
   * know a conversation moved on while you were reading back through it —
   * because the one place a new message *doesn't* announce itself is the thread
   * you already have open.
   *
   * `awayFrom` does both jobs: whether to show the control at all, and what
   * "new" is counted against. Two pieces of state (a boolean and a marker) would
   * be two things that can disagree, and the marker has to be captured at
   * exactly the moment the boolean flips.
   */
  const [awayFrom, setAwayFrom] = useState(null);
  const newestAt = messages[0] ? Date.parse(messages[0].created_at) : 0;
  const missed =
    awayFrom === null
      ? 0
      : messages.filter(
          (m) => m.sender.id !== me?.pk && Date.parse(m.created_at) > awayFrom
        ).length;

  /**
   * The scroller is `flex-col-reverse`, so its scroll origin is the **bottom**:
   * `scrollTop` is 0 at the newest message and runs negative as you scroll back
   * through history. That's what pins the newest message with no effect (it
   * deleted a `scrollIntoView`-on-every-change hack) and what keeps your place
   * when a page of older messages prepends — the browser measures from the
   * bottom, so content appearing above doesn't move what you're reading.
   *
   * `Math.abs` because that sign convention is the spec's but was not always
   * every engine's; the distances below are the same either way.
   */
  const handleScroll = useCallback(
    (event) => {
      const el = event.currentTarget;
      const fromNewest = Math.abs(el.scrollTop);
      setAwayFrom((current) =>
        fromNewest > JUMP_THRESHOLD ? (current ?? newestAt) : null
      );
      // Distance from the *oldest* loaded message, i.e. the top of the scroller.
      if (el.scrollHeight - el.clientHeight - fromNewest < OLDER_THRESHOLD) {
        loadOlder();
      }
    },
    [newestAt, loadOlder]
  );
  const jumpToLatest = useCallback(() => {
    // 0 is the bottom in a column-reverse scroller, which is where latest is.
    // The scroll handler clears `awayFrom` when we arrive; clearing it here as
    // well would hide the button, then a smooth-scroll frame still past the
    // threshold would bring it back with a freshly captured marker — a flash of
    // "Jump to latest ↓" with no count on the way to the bottom.
    scrollRef.current?.scrollTo?.({ top: 0, behavior: "smooth" });
  }, []);

  /**
   * Mark read on open and as new messages land, clearing the badges.
   *
   * **It waits for the detail**, where it used to fire on mount. The unread
   * divider is drawn from `unread_count` on that payload and this POST is what
   * zeroes it, so running before the detail lands makes the two race, with the
   * divider missing whenever the write wins.
   */
  const detailLoaded = !!detail;
  useEffect(() => {
    if (convoQuery.isError || isPending || !detailLoaded) return;
    // The unread count has already been latched during render, above — this is
    // the write it has to survive.
    api.markConversationRead(conversationId).then(() => {
      queryClient.invalidateQueries({ queryKey: ["unreadMessages"] });
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    });
  }, [
    conversationId,
    messageCount,
    convoQuery.isError,
    isPending,
    detailLoaded,
    queryClient,
  ]);

  /**
   * Keep the draft store in step with the composer.
   *
   * **Skipped while editing**, which is the one case that would write the wrong
   * thing: in edit mode the composer holds an existing *message*, not a draft of
   * yours, so persisting it would mean coming back to someone's sent words
   * sitting in your input. The pre-edit draft is already stored, and
   * `stashedDraft` puts it back on screen.
   */
  useEffect(() => {
    if (!editing) setDraft(conversationId, text);
  }, [conversationId, text, editing]);

  const sendMutation = useMutation({
    mutationFn: (value) => api.sendMessage(conversationId, value),
    onSuccess: () => {
      setText("");
      queryClient.invalidateQueries({ queryKey: ["messages", conversationId] });
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });

  const editMutation = useMutation({
    mutationFn: ({ messageId, value }) =>
      api.editMessage(conversationId, messageId, value),
    onSuccess: () => {
      stopEditing();
      queryClient.invalidateQueries({ queryKey: ["messages", conversationId] });
      // The list preview reads the latest message's text, so a correction to the
      // most recent message has to refresh it — even though an edit deliberately
      // doesn't reorder the list.
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

  function startEditing(message) {
    // Only stash on the way *into* edit mode. Switching straight from editing
    // one message to another would otherwise overwrite the draft with the first
    // message's text — losing the very thing the stash exists to protect.
    if (!editing) setStashedDraft(text);
    setEditing(message);
    setText(message.text);
    editMutation.reset();
    inputRef.current?.focus();
  }

  /** Leave edit mode and put the pre-edit draft back in the composer. */
  function stopEditing() {
    setEditing(null);
    setText(stashedDraft);
    setStashedDraft("");
    // Clear any failed-edit error with the mode that produced it, or it lingers
    // over a composer that's no longer editing anything.
    editMutation.reset();
  }

  function handleSubmit(event) {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    if (editing) {
      if (editMutation.isPending) return;
      // Saving the original text unchanged is a no-op, not a pointless PATCH
      // that would stamp the message "Edited" for nothing.
      if (value === editing.text) stopEditing();
      else editMutation.mutate({ messageId: editing.id, value });
      return;
    }
    if (sendMutation.isPending) return;
    sendMutation.mutate(value);
  }

  const other = detail?.other;
  const participants = detail?.participants ?? [];
  // Renamed from Phase 5's `can_message` — see ConversationSerializer.
  const canSend = detail?.can_send ?? false;

  // Deliberately *not* memoised: it's called when a menu opens, not during
  // render, and a memo would freeze the handlers around a stale `text` — which
  // is exactly the draft `startEditing` stashes.
  const getActions = (message) =>
    messageActions({
      message,
      mine: message.sender.id === me?.pk,
      canSend,
      now: Date.now(),
      onEdit: startEditing,
      onDelete: (messageId) => deleteMutation.mutate(messageId),
      onReport: (messageId) => setReportingId(messageId),
    });

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
          <div className="relative flex-1 overflow-hidden">
            {/* The transcript. `flex-col-reverse` is the whole mechanism: rows
                come newest-first, index 0 paints at the bottom, and the scroll
                origin is the newest message — so the thread opens at the bottom
                with no scrolling code, and a page of older messages prepending
                doesn't move what you're reading. */}
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              // `log` is the ARIA role for a running transcript — but its
              // implied `aria-live="polite"` is turned off deliberately. A live
              // region announces *additions*, and this container grows at both
              // ends: paging in twenty older messages would read all twenty
              // aloud, which is worse than silence. Announcing only genuinely
              // new messages needs a separate visually-hidden region fed one
              // message at a time, which is its own job rather than a side
              // effect of the role.
              role="log"
              aria-live="off"
              aria-label="Conversation"
              className="flex h-full flex-col-reverse overflow-y-auto px-4 py-4"
            >
              {messagesQuery.isLoading ? (
                <p className="py-10 text-center text-ink-faint">Loading…</p>
              ) : rows.length === 0 ? (
                <p className="py-10 text-center text-ink-faint">
                  No messages yet — say hello.
                </p>
              ) : (
                <ul className="flex flex-col-reverse">
                  {rows.map((row) => {
                    if (row.kind === "day") {
                      return <DaySeparator key={row.key} label={row.label} />;
                    }
                    if (row.kind === "unread") {
                      return (
                        <UnreadDivider
                          key={row.key}
                          count={row.count}
                          elementRef={unreadRef}
                        />
                      );
                    }
                    const mine = row.message.sender.id === me?.pk;
                    return (
                      <MessageBubble
                        key={row.key}
                        message={row.message}
                        mine={mine}
                        // A run's *first* bubble is the one attributed, so a
                        // burst reads as one block instead of repeating the name
                        // on every line.
                        showSender={isGroup && !mine && row.startsRun}
                        startsRun={row.startsRun}
                        endsRun={row.endsRun}
                        getActions={getActions}
                      />
                    );
                  })}
                </ul>
              )}
              {/* Last in the DOM, so `flex-col-reverse` paints it at the *top*
                  of the history — where "earlier messages" belongs.

                  Scrolling up is the main way older messages load, but it can't
                  be the only way: `onScroll` never fires on a transcript that
                  doesn't overflow, so a first page that fits the panel on a tall
                  window would leave the rest of the chat unreachable. The app
                  doesn't have this problem because `onEndReached` fires on
                  *layout*. This is the shared `LoadMoreButton` every other
                  paginated list in the app uses, and it renders nothing at all
                  once there's no next page. */}
              <LoadMoreButton query={messagesQuery} />
            </div>

            {awayFrom !== null && (
              <button
                type="button"
                onClick={jumpToLatest}
                className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-line bg-raised px-3 py-1.5 text-xs font-medium text-ink shadow-lg transition hover:border-accent hover:text-accent-deep"
              >
                {missed > 0
                  ? `${missed} new message${missed === 1 ? "" : "s"} ↓`
                  : "Jump to latest ↓"}
              </button>
            )}
          </div>

          <div className="border-t border-line px-3 py-3">
            {canSend ? (
              <>
                {/* The editing bar: what you're rewriting, and a way out of it.
                    The original is shown raw rather than cleaned up — the
                    composer below holds that exact string, and a tidied version
                    above the source you're typing into would be the one place
                    dropping the markup misleads. */}
                {editing && (
                  <div className="mb-2 flex items-start gap-2 rounded-xl border border-line bg-raised px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-[0.7rem] font-semibold uppercase tracking-wide text-accent-deep">
                        Editing message
                      </p>
                      <p className="truncate text-sm text-ink-soft">
                        {editing.text}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={stopEditing}
                      aria-label="Cancel editing"
                      className="shrink-0 rounded-full px-1 text-ink-faint transition hover:text-ink"
                    >
                      ✕
                    </button>
                  </div>
                )}
                <form onSubmit={handleSubmit} className="flex items-end gap-2">
                  <textarea
                    ref={inputRef}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleSubmit(e);
                      }
                      // Escape leaves edit mode rather than closing the drawer:
                      // the nearer thing wins, and losing the whole panel
                      // mid-correction would be a surprise.
                      if (e.key === "Escape" && editing) {
                        e.preventDefault();
                        e.stopPropagation();
                        stopEditing();
                      }
                    }}
                    rows={1}
                    placeholder={
                      editing ? "Edit your message…" : "Write a message…"
                    }
                    className="max-h-32 flex-1 resize-none rounded-2xl border border-line-strong bg-raised px-4 py-2.5 text-base text-ink transition placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-tint"
                  />
                  <button
                    type="submit"
                    disabled={
                      !text.trim() ||
                      sendMutation.isPending ||
                      editMutation.isPending
                    }
                    className="btn btn-primary btn-sm mb-0.5"
                  >
                    {editing
                      ? editMutation.isPending
                        ? "Saving…"
                        : "Save"
                      : sendMutation.isPending
                        ? "Sending…"
                        : "Send"}
                  </button>
                </form>
              </>
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
            {editMutation.isError && (
              <p role="alert" className="mt-1 text-sm text-red-600">
                {editMutation.error?.message || "Couldn’t save the edit."}
              </p>
            )}
          </div>
        </>
      )}

      {reportingId !== null && (
        <ReportModal
          messageId={reportingId}
          onClose={() => setReportingId(null)}
        />
      )}
    </>
  );
}
