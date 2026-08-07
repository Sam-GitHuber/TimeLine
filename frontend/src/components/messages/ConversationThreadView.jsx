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
import { StrokeIcon, PanelHeader } from "../drawer-chrome.jsx";
import PendingChatPanel from "../PendingChatPanel.jsx";
import { ReportModal } from "../ReportModal.jsx";
import AvatarStack from "./AvatarStack.jsx";
import DrawerMenu from "./DrawerMenu.jsx";
import MentionSuggestions from "./MentionSuggestions.jsx";
import MessageBubble from "./MessageBubble.jsx";
import MessageStrandPanel, { threadQueryKey } from "./MessageStrandPanel.jsx";
import { DaySeparator, UnreadDivider } from "./ThreadDividers.jsx";
import { reactorsQueryKey } from "../ReactorsPopover.jsx";
import {
  api,
  CONVERSATION_DETAIL_POLL_MS,
  MESSAGE_EDIT_WINDOW_MS,
  MESSAGE_POLL_MS,
} from "../../api.js";
import { useAuth } from "../../auth.jsx";
import { prepareChatPhoto } from "../../chatPhotos.js";
import { getDraft, setDraft } from "../../drafts.js";
import { serverMessage } from "../../errors.js";
import { useDayBoundary } from "../../hooks.js";
import { useMentions } from "../../mentions.js";
import { insertMessage, patchReactions } from "../../messageCache.js";
import { useHoldMessagesOpen, useMessaging } from "../../messaging.jsx";
import { asMessage, newOutgoing, updateOutbox, useOutbox } from "../../outbox.js";
import { readStateFor, receiptsVisible } from "../../readReceipts.js";
import { firstUnreadId, toThreadRows } from "../../threadRows.js";

// How far from the newest message counts as "scrolled away", in px — the point
// at which jump-to-latest appears.
const JUMP_THRESHOLD = 200;
// How close to the top of the loaded history a scroll gets before the next page
// of older messages is fetched.
const OLDER_THRESHOLD = 300;

/**
 * The name in the thread header, and the one thing that stayed beside it when
 * M9e emptied that header into a menu: **a muted thread still says "Muted" up
 * here.**
 *
 * That's the exception rather than an inconsistency. Everything else the header
 * carried was an *action*, and actions belong in the menu; "Muted" is a *state*,
 * and the whole risk of muting a chat is forgetting you did — so it has to be
 * visible somewhere you'd notice while reading, not two clicks away on the panel
 * that set it.
 */
function HeaderName({ name, muted }) {
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="truncate font-display font-bold -tracking-[0.02em] text-ink">
        {name}
      </span>
      {muted && (
        <span className="shrink-0 text-[0.7rem] font-semibold uppercase tracking-wide text-ink-faint">
          Muted
        </span>
      )}
    </span>
  );
}

/**
 * What the ⋯ menu offers for one message (Phase 9b M9b).
 *
 * A plain function of its inputs — `now` is passed in, not read — so the list is
 * decided when the menu opens rather than when React last redrew the bubble.
 * Edit expires fifteen minutes after sending, and a menu whose contents depend
 * on render timing is the kind of bug nobody reproduces.
 *
 * **Data, not JSX**, deliberately — M9c slotted React in, M9d Reply and M9f
 * Select, none of which had to re-read a tree of conditional markup to do it.
 *
 * Edit appears only on your own message, only inside the edit window, and only
 * while you can still send here. The server enforces all three independently
 * ([`messaging.md`](../../../../docs/reference/messaging.md) → *Editing a
 * message*); this only avoids offering an action that would come back 403.
 *
 * `allowEdit` is how the strand asks for one item fewer (M9d). Editing needs a
 * composer mode and the strand's composer already has a job — see
 * `MessageStrandPanel`. Everything else is offered identically in both, which is
 * why this stayed one function rather than becoming two lists to keep in step.
 */
function messageActions({
  message,
  mine,
  canSend,
  allowEdit = true,
  now,
  onReply,
  onEdit,
  onDelete,
  onReport,
  onSelect,
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
  /**
   * The way into select mode (M9f), and it belongs here for the reason the app's
   * does: this menu is already the answer to "do something with this message",
   * and the second message you want is the one you go for *after* deciding
   * there's more than one. Offered only where there's a mode to enter — the
   * strand has no bulk actions, so `onSelect` is simply absent there.
   */
  if (onSelect) {
    actions.push({ label: "Select", onClick: () => onSelect(message) });
  }
  /**
   * Reply, and **the only route to one** (M9d) — it opens the strand rather
   * than aiming this composer at a message, even when the message has no
   * replies yet and the strand is one bubble long. That's the point: a reply
   * needs the exchange it's joining visible while you write it, which a
   * "Replying to X" bar above the composer can never show. The phone built the
   * bar first, used it, and threw it away; the web starts where that ended.
   */
  if (canSend) {
    actions.push({ label: "Reply", onClick: () => onReply(message) });
  }
  if (mine) {
    const age = now - new Date(message.created_at).getTime();
    if (allowEdit && canSend && age < MESSAGE_EDIT_WINDOW_MS) {
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
  const { conversationId, openList, openInfo, openNew } = useMessaging();
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
  /**
   * The open reply strand, or null for the transcript alone (M9d).
   *
   * `rootId` is the strand's head; `replyToId` the message actually clicked,
   * which is only the root when you got here by browsing. The two differ when
   * you reply to something that's already a reply, and keeping both is what lets
   * the quote name who you answered rather than who started the strand.
   */
  const [strand, setStrand] = useState(null);
  /**
   * The photo waiting to go with the next message (M9e), already resized,
   * EXIF-stripped and re-encoded by `prepareChatPhoto` — plus the moment while
   * that's happening, and anything that went wrong doing it.
   *
   * 🔒 Never the raw `File` off the input. The server does not open a chat
   * attachment (it can't, under E2E), so this client-side pass is the *only*
   * thing between a phone photo's GPS coordinates and everyone in the chat.
   */
  const [attachment, setAttachment] = useState(null);
  const [preparing, setPreparing] = useState(false);
  const [photoError, setPhotoError] = useState(null);
  /**
   * The ticked messages while selecting (M9f), or `null` when there's no
   * selection mode running at all.
   *
   * `null` rather than an empty set, because "no mode" and "mode with nothing
   * ticked" are genuinely different states: the second still shows the count
   * header and the bulk bar, and it's reachable by unticking the message you
   * entered with.
   */
  const [selected, setSelected] = useState(null);
  const selecting = selected !== null;
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);

  /**
   * The conversation detail — identity, permissions, and (M9c) each
   * participant's read marker, which is what the ticks are computed from.
   *
   * **Polled**, where it used to be fetched once: a marker taken when the thread
   * opened is by construction older than every message you send afterwards, so a
   * mount-time snapshot could only ever say "sent" about the message you're
   * watching. Slower than the message poll on purpose — see
   * `CONVERSATION_DETAIL_POLL_MS`.
   */
  const convoQuery = useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: () => api.getConversation(conversationId),
    refetchInterval: CONVERSATION_DETAIL_POLL_MS,
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
  /** What the server has accepted, newest-first. The outbox sits in front of it
   * when the rows are built, below. */
  const loaded = useMemo(
    () => pages?.pages.flatMap((page) => page.results) ?? [],
    [pages]
  );
  const messageCount = loaded.length;

  /**
   * Messages you've sent that the server hasn't accepted yet (M9c) — held
   * outside the query cache, and outside this component, so a failed send
   * survives both a poll and a click back to the conversation list. See
   * `outbox.js` for why the obvious shape (an optimistic cache write) doesn't
   * work here.
   */
  const outbox = useOutbox(conversationId);
  const setOutbox = useCallback(
    (update) => updateOutbox(conversationId, update),
    [conversationId]
  );
  /** You, as a message sender — what an outbox entry is dressed in. */
  const meAsAuthor = useMemo(
    () => ({
      id: me?.pk ?? -1,
      display_name: me?.display_name ?? "",
      avatar_thumb: me?.avatar_thumb ?? null,
    }),
    [me?.pk, me?.display_name, me?.avatar_thumb]
  );
  const outboxById = new Map(outbox.map((entry) => [entry.tempId, entry]));

  /**
   * Server ids of messages that arrived here by *your* sending them, so their
   * bubble can skip the arrival animation.
   *
   * ⚠️ Not a nicety — without it every send animates **twice**. A transcript row
   * is keyed `m-${id}`, and settling an outbox entry swaps a negative `tempId`
   * for the server's id, so React unmounts the bubble and mounts a new one —
   * which re-runs `.msg-bubble`'s `tl-rise` (a fade up from nothing) a fraction
   * of a second after the message appeared. That flash is precisely the
   * "message that appears to *change* when it lands" the outbox exists to
   * prevent, so the optimistic bubble animates and its replacement doesn't.
   *
   * State rather than a ref because it's read during render, and `useState`'s
   * lazy initialiser rather than a fresh `new Set()` each render. It's bounded
   * by what you send in one sitting: the view is keyed on the conversation id,
   * so switching chats starts a new one.
   */
  const [justSent, setJustSent] = useState(() => new Set());

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
    const anchor = firstUnreadId(loaded, unreadOnOpen, me?.pk);
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
   * Everything the server hasn't accepted goes at the **front** (M9c).
   * Concatenating rather than merging by timestamp is both correct and simpler:
   * a message that hasn't been accepted is by definition newer than every
   * message that has.
   *
   * `today` is a dependency, not a value used directly: it changes at local
   * midnight, the one moment "Today" and "Yesterday" go stale with no data
   * having changed.
   */
  const today = useDayBoundary();
  const rows = useMemo(
    () =>
      toThreadRows({
        messages: [
          // Reversed on the way in: the outbox holds entries oldest-first, and
          // everything downstream of here is newest-first.
          ...outbox.map((entry) => asMessage(entry, meAsAuthor)).reverse(),
          ...loaded,
        ],
        meId: me?.pk,
        unread,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see `today` above
    [loaded, outbox, meAsAuthor, me?.pk, unread, today]
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
  const newestAt = loaded[0] ? Date.parse(loaded[0].created_at) : 0;
  const missed =
    awayFrom === null
      ? 0
      : loaded.filter(
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

  /**
   * Escape leaves select mode rather than closing the drawer (M9f) — the nearer
   * thing wins, the same call the composer already makes for edit mode and the
   * strand for itself.
   *
   * On `document` in the **capture** phase, which is what puts it ahead of the
   * drawer's own Escape handler: that one is a bubble-phase document listener,
   * so stopping propagation up here means it never runs. Without this, changing
   * your mind about a selection would cost you the whole panel — and there'd be
   * no composer to catch the key, since the bulk bar has taken its place.
   */
  useEffect(() => {
    if (!selecting) return;
    function onKeyDown(event) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setSelected(null);
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [selecting]);

  /**
   * Put focus back in the composer when a strand closes (M9d).
   *
   * Whatever focus was on — the strand's Close button, or its composer — has
   * just unmounted, so without this focus falls to `<body>` and the next Tab
   * starts at the top of the *page*, outside a drawer that is deliberately not a
   * focus trap. A keyboard user who opened a thread and left it again would be
   * put out of the panel for their trouble.
   *
   * In an effect rather than in the close handler because the composer is inside
   * a `display: none` subtree until that render commits, and `.focus()` on a
   * hidden element does nothing at all.
   */
  const hadStrand = useRef(false);
  useEffect(() => {
    if (hadStrand.current && !strand) inputRef.current?.focus();
    hadStrand.current = !!strand;
  }, [strand]);

  /**
   * Send one message and settle its outbox entry (M9c).
   *
   * The composer is **not** touched here — it was cleared the moment the message
   * went into the outbox. Clearing on the response was right when the response
   * was the first sign anything had happened; now it would wipe whatever you'd
   * started typing in the seconds since, which is the exact draft loss
   * `stashedDraft` exists to prevent, just triggered by your own previous
   * message landing.
   */
  const sendMutation = useMutation({
    // `?? null` so an ordinary message sends an explicit "this is not a reply"
    // rather than a hole an argument could later slide into.
    mutationFn: ({ value, replyToId, photo, mentionIds }) =>
      api.sendMessage(
        conversationId,
        value,
        replyToId ?? null,
        photo ?? null,
        mentionIds ?? null
      ),
    onSuccess: (message, { tempId }) => {
      // Marked before either write, so the replacement bubble is already known
      // to be yours by the time it renders — see `justSent`. Out of order it
      // would animate once and then be told not to.
      setJustSent((sent) => new Set(sent).add(message.id));
      // Write the accepted message into the cache *before* dropping the outbox
      // entry, so the bubble is never absent for the frame between the two.
      // React batches both, but the ordering is what makes that true rather
      // than incidental.
      queryClient.setQueryData(["messages", conversationId], (cached) =>
        insertMessage(cached, message, { newestFirst: true })
      );
      // And into the strand it belongs to, if it's a reply (M9d). The panel
      // reads its own query, so without this a reply sent from in there blinks
      // out of the strand between the response landing and the refetch coming
      // back — the very flicker the write above exists to prevent, just in the
      // other view. `thread_root_id` comes off the server's copy rather than
      // the client's guess: the server decides which strand a reply flattens
      // into, and `newestFirst: false` because a strand reads the endpoint's
      // default oldest-first order.
      if (message.thread_root_id) {
        queryClient.setQueryData(
          threadQueryKey(conversationId, message.thread_root_id),
          (cached) => insertMessage(cached, message, { newestFirst: false })
        );
      }
      setOutbox((entries) => entries.filter((e) => e.tempId !== tempId));
      queryClient.invalidateQueries({ queryKey: ["messages", conversationId] });
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      // The strand reads its own query, so a reply has to refresh it — otherwise
      // an open strand sits a poll cycle behind the transcript behind it. Also
      // what brings the root's freshly incremented `reply_count` in.
      queryClient.invalidateQueries({ queryKey: ["thread", conversationId] });
    },
    // The message stays put and goes to `failed`; the bubble grows Retry and
    // Discard. Nothing is thrown away, and there's no banner under the composer
    // — the failure is already visible on the thing that failed, which is a
    // better place to say it than somewhere that can't tell you *which* of two
    // messages in flight fell over.
    //
    // **The reason is kept, not just the fact** (M9e). A text send fails because
    // the network blinked, and Retry is the whole answer; a *photo* can fail
    // because the server refused it — over the 4 MB cap, or a thread you've been
    // severed from — and that is deterministic, so a bubble offering nothing but
    // Retry invites someone to press it forever. Saying what the server said
    // turns a loop into a decision.
    onError: (error, { tempId }) =>
      setOutbox((entries) =>
        entries.map((e) =>
          e.tempId === tempId
            ? { ...e, status: "failed", error: serverMessage(error, null) }
            : e
        )
      ),
  });

  /**
   * Send, showing the message immediately (M9c).
   *
   * Everything that sends in this view goes through here, so there's one place
   * that knows an unsent message exists and one place that decides what happens
   * when it doesn't land.
   */
  function queueSend(value, { replyToId, rootId, photo, mentionIds } = {}) {
    const entry = newOutgoing({
      text: value,
      replyToId,
      rootId,
      photo,
      mentionIds,
    });
    setOutbox((entries) => [...entries, entry]);
    sendMutation.mutate({
      value,
      replyToId,
      photo,
      mentionIds,
      tempId: entry.tempId,
    });
  }

  function retrySend(entry) {
    setOutbox((entries) =>
      entries.map((e) =>
        // The previous reason goes with the retry: leaving it under a bubble
        // that's trying again would be reporting a failure that hasn't happened
        // yet, and it'll be back in a moment if it's still true.
        e.tempId === entry.tempId
          ? { ...e, status: "sending", error: null }
          : e
      )
    );
    // Everything off the entry, not recomputed: a failed reply retried without
    // its `replyToId` would quietly become an ordinary message, landing in the
    // transcript instead of the strand you sent it from; a failed *photo*
    // retried without its `photo` would send the caption alone and drop the
    // picture; and a retry without its `mentionIds` would leave the `@Ada` in
    // the words with nothing behind it — no notification through her mute, and
    // no highlight either. Three different silent downgrades, one rule.
    sendMutation.mutate({
      value: entry.text,
      replyToId: entry.replyToId,
      photo: entry.photo,
      mentionIds: entry.mentionIds,
      tempId: entry.tempId,
    });
  }

  /** Give up on a failed send. The only way outbox text is ever thrown away. */
  function discardSend(tempId) {
    setOutbox((entries) => entries.filter((e) => e.tempId !== tempId));
  }

  /**
   * Toggle an emoji on a message (M9c).
   *
   * 🔒 **No optimistic write** — M2's fifth decision, and it holds on the web
   * for the same reason: simulating the toggle locally means a second copy of
   * rules the server owns (the per-target cap, emoji validation, count-then-
   * emoji ordering) that can show a pill and then take it away.
   */
  const reactMutation = useMutation({
    mutationFn: ({ messageId, emoji }) =>
      api.toggleReaction({ messageId, emoji }),
    onSuccess: (data, { messageId }) => {
      queryClient.setQueryData(["messages", conversationId], (cached) =>
        patchReactions(cached, messageId, data.reactions ?? [])
      );
      // And into any open strand (M9d), which reads a cache of its own. Writing
      // only the transcript's isn't a *wrong* pill in here, it's no pill at all
      // until the next poll — up to `MESSAGE_POLL_MS` of a one-click gesture
      // looking as though it did nothing, and unnoticeable in review because the
      // transcript holding the right answer is hidden while a strand is open.
      // Deliberately no optimistic write, still: this is the server's answer,
      // arriving in both places at once (see `messageCache.js`).
      //
      // `setQueriesData` on the prefix rather than one key, because the reacted
      // message's strand isn't necessarily the open one — a cached strand left
      // behind by an earlier visit must not come back holding a stale pill.
      queryClient.setQueriesData(
        { queryKey: ["thread", conversationId] },
        (cached) => patchReactions(cached, messageId, data.reactions ?? [])
      );
      // The reactor list is a *separate* cache that outlives the popover, so it
      // has to be dealt with too — otherwise the next open renders the
      // pre-toggle list, and because that list is actionable, a row still
      // saying "tap to remove" for a reaction you already removed would toggle
      // it straight back on.
      //
      // `removeQueries`, not `invalidateQueries`: the popover is closed by now,
      // so the query is *inactive* and invalidation would only mark it stale —
      // reopening would still render the stale rows for the length of a round
      // trip, which is exactly the window in which they can be clicked.
      queryClient.removeQueries({ queryKey: reactorsQueryKey({ messageId }) });
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
      // Delete is offered inside the strand as well (M9d), and the strand reads
      // its own query — so without this the message you just deleted sits there
      // until the next poll, in the one view that's on screen at the time.
      queryClient.invalidateQueries({ queryKey: ["thread", conversationId] });
    },
  });

  /**
   * Delete everything ticked, in one action (M9f).
   *
   * **One at a time rather than in parallel**, because nobody is waiting on the
   * round trips — the bubbles left the selection the moment you confirmed — and
   * a burst of parallel DELETEs is a burst for no benefit.
   *
   * **Invalidated on settle, not on success.** A partial failure still deleted
   * some of them, and leaving those on screen would make the whole action look
   * as though it had failed. The strand's cache is invalidated too, for M9d's
   * reason: a deleted message the strand still holds is invisible in review,
   * because the transcript that has the right answer is hidden while a strand is
   * open.
   */
  const deleteManyMutation = useMutation({
    mutationFn: async (messageIds) => {
      for (const messageId of messageIds) {
        await api.deleteMessage(conversationId, messageId);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["messages", conversationId] });
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      queryClient.invalidateQueries({ queryKey: ["thread", conversationId] });
    },
  });

  // Leave (or, while pending, decline) a chat — group-only in the header;
  // PendingChatPanel has its own copy of this for the locked view, and the
  // Details panel a third. All three now refresh the same two keys, as all three
  // of the app's copies always have: `ConversationLeaveView` tombstones your
  // participant row and `user_conversations` filters on `left_at__isnull=True`,
  // so the chat is off your list server-side the moment this succeeds. Refresh
  // before `openList()` hands you that list, or you land on a cache still
  // showing the chat you just left — and clicking it 404s, because a chat you're
  // not in shouldn't admit it exists (#286).
  const leaveMutation = useMutation({
    mutationFn: () => api.leaveConversation(conversationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      queryClient.invalidateQueries({ queryKey: ["unreadMessages"] });
      openList();
    },
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

  /**
   * **Every write that reports itself in the error bar holds the drawer open**
   * (#257, #258, #238). That bar at the foot of this view is the only place any
   * of them is reported, and leaving the thread unmounts the whole view — so
   * while one is out, the drawer's Escape, ✕, Back and nav button hold. The
   * bar's own comment used to say the unmounting half was somebody else's open
   * bug; it isn't now.
   *
   * It was the edit and the bulk delete alone until #238, because the other
   * three said nothing when they failed and so had nothing to protect. The bulk
   * delete is still the *longest* window: its `mutationFn` walks the selection
   * one `DELETE` at a time, so `isPending` spans every one of them.
   *
   * The bar's remaining occupant, `photoError`, deliberately isn't here.
   * Preparing a photo is a client-side decode/re-encode, not a write — the rule
   * is about a request whose answer you're waiting on, and holding the whole
   * drawer shut while a picture is being resized would be the gate outstaying
   * its purpose.
   *
   * Named once and read everywhere, because the drawer's four exits are not the
   * only way out of this view: the controls inside it that switch `view` unmount
   * it just as completely, and they have to hold on the *same* condition. Two of
   * them gated on the edit alone until this was hoisted, which left the bulk
   * delete — the longer window — reported into a bar the user could still
   * navigate out from under.
   *
   * ⚠️ Declared below all five mutations, not beside the first two. It reads
   * every one of them, and a `const` hoisted above `leaveMutation` would be a
   * temporal-dead-zone throw rather than a stale read.
   */
  const reportingWrite =
    editMutation.isPending ||
    deleteManyMutation.isPending ||
    deleteMutation.isPending ||
    leaveMutation.isPending ||
    muteMutation.isPending;

  useHoldMessagesOpen(reportingWrite);

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

  /**
   * Leave edit mode and put the pre-edit draft back in the composer.
   *
   * **Never called with a PATCH in flight**, by any of its four routes: the two
   * ways out of edit mode by hand (Escape and the ✕ beside the quoted message)
   * hold while `editMutation.isPending`; the mutation's own `onSuccess` runs
   * when the answer has arrived; and `handleSubmit`'s unchanged-text branch —
   * which leaves edit mode *instead of* sending anything — is behind
   * `canSubmit`, whose `editing` arm carries `!editMutation.isPending` too.
   * That's what makes the `reset()` below safe, and it was issue #257 when it
   * wasn't: `reset()` detaches the observer from a running mutation, so a 403
   * arriving after you'd pressed Escape had nothing left to paint it. You'd
   * leave believing the typo was fixed.
   *
   * The guard is deliberately *not* in here as a blanket `if (isPending)
   * return`: React Query runs `onSuccess` before the mutation leaves its
   * pending state, so a guard here would refuse the one call that has to work.
   */
  function stopEditing() {
    setEditing(null);
    setText(stashedDraft);
    setStashedDraft("");
    // Clear the failed-edit error with the mode that produced it, or it lingers
    // over a composer that's no longer editing anything. Settled by the time we
    // get here, so this only ever discards an answer that has already arrived.
    editMutation.reset();
  }

  /**
   * Attach a photo (M9e) — resized, EXIF-stripped and re-encoded here in the
   * browser before it goes anywhere.
   *
   * **A file input is the whole affordance, and there's no camera.** The app
   * offers one because taking a picture of what's in front of you is half of
   * what a photo in a chat is for on a phone; at a desk it isn't, and reaching
   * for `getUserMedia` would mean a permission prompt, a preview surface and a
   * shutter to build the one case a webcam serves worse than the file picker
   * already does.
   *
   * The input is cleared afterwards so choosing the *same* file twice still
   * fires `change` — otherwise removing a photo and picking it again silently
   * does nothing.
   */
  async function handleFileChosen(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setPhotoError(null);
    setPreparing(true);
    try {
      // 🔒 This is where the photo is downscaled and its EXIF — including the
      // GPS coordinates a phone stamps on every shot — is stripped, by being
      // re-encoded from raw pixels. The server does none of that for chat
      // photos, on purpose (see `chatPhotos.js`), so skipping this step would
      // send everyone in the thread the location the picture was taken.
      setAttachment(await prepareChatPhoto(file));
    } catch {
      setPhotoError("Couldn’t use that photo. Try another one.");
    } finally {
      setPreparing(false);
    }
  }

  /** Take the photo back off the composer, releasing its preview URL with it. */
  function removeAttachment() {
    if (attachment) URL.revokeObjectURL(attachment.previewUrl);
    setAttachment(null);
    setPhotoError(null);
  }

  /**
   * Release a queued photo's preview URL if the view goes away still holding it
   * (M9e) — closing the drawer, or switching to another chat, which remounts
   * this view because it's keyed on the conversation id.
   *
   * The other two exits are already covered: `removeAttachment` revokes when you
   * take the photo off, and `outbox.js` takes ownership the moment one is handed
   * over to a send. This is the third, and without it every abandoned pick pins
   * its thumbnail's bytes until the tab closes.
   *
   * Through a ref, and the cleanup runs on unmount **only** — keying the effect
   * on `attachment` would revoke on every change, including the one that hands
   * the photo to the outbox, blanking the in-flight bubble that's now drawing it.
   */
  const attachmentRef = useRef(null);
  useEffect(() => {
    attachmentRef.current = attachment;
  }, [attachment]);
  useEffect(
    () => () => {
      const held = attachmentRef.current;
      if (held) URL.revokeObjectURL(held.previewUrl);
    },
    []
  );

  /**
   * Whether there's anything to submit — read by both the button's `disabled`
   * and `handleSubmit`, so the two can't disagree about it.
   *
   * ⚠️ **An edit and a send ask different questions**, and conflating them was a
   * real bug: a queued photo made `!value` false, so clearing the field mid-edit
   * fired a `PATCH` with empty text where the old code had returned early. The
   * server 400s that on a text message ("A message can't be empty") — but it
   * *allows* it on a photo message, since editing a caption down to nothing is a
   * legitimate thing to do. That's the rule mirrored here: an edit needs words
   * unless the message it's editing carries a photo of its own. The composer's
   * queued attachment has nothing to do with it — a `PATCH` can't carry one.
   */
  const editingHasPhoto = (editing?.attachments?.length ?? 0) > 0;
  const canSubmit = preparing
    ? false
    : editing
      ? (!!text.trim() || editingHasPhoto) && !editMutation.isPending
      : !!text.trim() || !!attachment;

  function handleSubmit(event) {
    event.preventDefault();
    const value = text.trim();
    if (!canSubmit) return;
    if (editing) {
      // Saving the original text unchanged is a no-op, not a pointless PATCH
      // that would stamp the message "Edited" for nothing.
      if (value === editing.text) stopEditing();
      else editMutation.mutate({ messageId: editing.id, value });
      return;
    }
    /**
     * **The composer clears on dispatch and never blocks** (M9c). Sending two
     * quick messages in a row is ordinary, and waiting for the first is exactly
     * the lag the outbox removes. An *edit* still blocks, above, because it
     * targets one specific message and two saves racing on it would be
     * genuinely ambiguous.
     */
    // Reconciled against what's actually being sent (M9f), not trusted from the
    // picker: pick Ada, change your mind, delete her name, send — and no id goes
    // with it, so her muted thread doesn't buzz about a message that doesn't
    // mention her. See `mentionIdsIn`.
    const mentionIds = mentions.idsFor(value);
    mentions.reset();
    setText("");
    // Handed to the outbox, which owns the preview URL from here on — so this
    // must *not* revoke it the way `removeAttachment` does.
    setAttachment(null);
    queueSend(value, { photo: attachment ?? undefined, mentionIds });
  }

  const other = detail?.other;
  // Memoised, not a bare `?? []`: the detail is re-fetched every
  // `CONVERSATION_DETAIL_POLL_MS` now, and a fresh empty array each time would
  // rebuild everything keyed off it on every tick.
  // Keyed on `detail` rather than on `detail?.participants`: an optional chain
  // in a dependency array is something the React Compiler's lint can't match to
  // the plain member access it infers, so it gives up on the whole component
  // (`Compilation Skipped`) rather than optimise it. React Query's structural
  // sharing means `detail` keeps its identity when a poll comes back unchanged,
  // so this is the same memo either way.
  const participants = useMemo(() => detail?.participants ?? [], [detail]);
  // Renamed from Phase 5's `can_message` — see ConversationSerializer.
  const canSend = detail?.can_send ?? false;

  /**
   * Whether this thread shows ticks at all. False means **you** turned read
   * receipts off, which the server signals by withholding every marker
   * including your own — and then the whole column disappears rather than
   * freezing on "sent", because a permanent single tick would read as "nobody
   * is ever opening these" where showing nothing says the true thing.
   */
  const showReceipts = receiptsVisible(participants);

  /**
   * Who can be named with `@`, and what everyone's name is (M9f).
   *
   * **Groups only.** In a 1:1 there is exactly one person it could mean, so a
   * picker would be ceremony around a word — and here it's more than a UI call:
   * the server *refuses* `mention_ids` on a direct conversation, because a
   * mention beats mute and in a 1:1 the one person you might have muted is the
   * only person who can send you anything (see `messaging.md`).
   *
   * `mentionNames` is separate and covers *everyone*, you included: it's what
   * the bubbles highlight from, and a message naming you has to light up as much
   * as one naming anyone else. The ids on a message are bare — the server sends
   * no names — so this map is the only thing that can turn them back into the
   * `@Ada` in the text.
   */
  const mentionable = useMemo(
    () =>
      isGroup
        ? participants.filter((p) => p.status === "active" && p.id !== me?.pk)
        : [],
    [isGroup, participants, me?.pk]
  );
  const mentionNames = useMemo(
    () => new Map(participants.map((p) => [p.id, p.display_name])),
    [participants]
  );
  const mentions = useMentions({
    people: mentionable,
    text,
    setText,
    inputRef,
  });

  /**
   * The tick (or clock) for one bubble. Never on someone else's message: a tick
   * reports what *your* message did, and on an incoming one it would be telling
   * you that you read it.
   */
  function statusFor(message) {
    if (message.sender.id !== me?.pk) return undefined;
    const pending = outboxById.get(message.id);
    if (pending) return pending.status;
    if (!showReceipts) return undefined;
    return readStateFor(message, participants, me?.pk);
  }

  /**
   * Enter select mode with the message you acted on already ticked (M9f).
   *
   * A burst is exactly where you know you want the *next* few as well, so
   * entering with nothing ticked would waste the click you just made.
   */
  function startSelecting(message) {
    // Clear a previous run's failure with the mode that produced it, or it sits
    // under the composer reporting something you've already moved on from.
    deleteManyMutation.reset();
    setSelected(new Set([message.id]));
  }

  function toggleSelected(messageId) {
    setSelected((current) => {
      const next = new Set(current ?? []);
      if (!next.delete(messageId)) next.add(messageId);
      return next;
    });
  }

  /**
   * The ticked messages, oldest-first — the order they were said in, which is
   * the only order a copied exchange reads correctly in.
   *
   * `loaded` is newest-first (the transcript reads `?order=desc`), so this
   * reverses rather than sorting: the list is already in order, just backwards.
   * It's drawn from `loaded` alone, which is also what keeps an unsent message
   * out of a selection — it has no server id to copy or delete by.
   *
   * Memoised because `deletableSelection` reads it during render and `loaded` is
   * every page fetched so far: walking all of it on each render while someone
   * clicks their way through a selection is work for nothing. Empty outside
   * select mode, so it costs nothing there either.
   */
  const selectedMessages = useMemo(
    () => (selected ? [...loaded].reverse().filter((m) => selected.has(m.id)) : []),
    [loaded, selected]
  );

  /**
   * Copy the lot as text.
   *
   * A group prefixes each line with who said it, because a copied exchange
   * between three people is unreadable otherwise; a 1:1 doesn't, since pasting
   * your own name into a note about a conversation you were in adds nothing.
   * Messages with no words (a photo on its own) are skipped rather than rendered
   * as a placeholder — the clipboard takes text, and "📷 Photo" is not something
   * anyone wants in their notes.
   */
  function copySelected() {
    const lines = selectedMessages
      .filter((m) => m.text && !m.is_deleted)
      .map((m) => (isGroup ? `${m.sender.display_name}: ${m.text}` : m.text));
    if (lines.length > 0) {
      navigator.clipboard?.writeText?.(lines.join("\n"))?.catch?.(() => {});
    }
    setSelected(null);
  }

  function confirmDeleteSelected() {
    const ids = selectedMessages.map((m) => m.id);
    const question =
      ids.length === 1
        ? "Delete this message? This can’t be undone."
        : `Delete ${ids.length} messages? This can’t be undone.`;
    if (!window.confirm(question)) return;
    deleteManyMutation.mutate(ids);
    setSelected(null);
  }

  /**
   * Whether every ticked message is one you could delete on its own — Delete is
   * offered only then. A bulk action that silently did *part* of what it says
   * (yours, quietly skipping theirs) is worse than one that isn't there, and
   * absent reads as "not yours" where a permanently greyed button reads as a bug.
   */
  // ⚠️ Counted off `selectedMessages`, not `selected.size` — the two can
  // disagree, and `.every()` on an empty array is `true`. A tick whose message
  // has since left `loaded` would otherwise offer Delete on nothing at all, and
  // ask "Delete 0 messages?" on the way.
  const deletableSelection =
    selecting &&
    selectedMessages.length > 0 &&
    selectedMessages.every((m) => m.sender.id === me?.pk && !m.is_deleted);

  /**
   * Open the strand a message belongs to (M9d), aimed at that message.
   *
   * The three routes in differ only in what they pass, and they all land here:
   * **Reply** in the ⋯ menu passes the message you clicked; a **root's reply
   * count** passes the root; a **reply's quote** passes the root as well, since
   * from a quote you're going to read before you write.
   */
  function openStrand(message, { aimAtRoot = false } = {}) {
    const rootId = message.thread_root_id ?? message.id;
    setStrand({ rootId, replyToId: aimAtRoot ? rootId : message.id });
  }

  // Deliberately *not* memoised: it's called when a menu opens, not during
  // render, and a memo would freeze the handlers around a stale `text` — which
  // is exactly the draft `startEditing` stashes.
  const getActions = (message) =>
    messageActions({
      message,
      mine: message.sender.id === me?.pk,
      canSend,
      now: Date.now(),
      onReply: (target) => openStrand(target),
      onEdit: startEditing,
      onDelete: (messageId) => deleteMutation.mutate(messageId),
      onReport: (messageId) => setReportingId(messageId),
      onSelect: startSelecting,
    });

  /**
   * The thread header's `⋯` (M9e) — what used to be three icon buttons.
   *
   * **Details is first and Mute is second**, in that order because Details is
   * where the rest of them now live, and a menu whose first item is the way to
   * everything else reads as a door rather than a drawer of leftovers. Mute
   * stays out here as well because it's the one people reach for mid-thread, and
   * it reads as its state — the risk of muting is forgetting you did.
   *
   * Add and Leave are group-only: there's nobody to add to a 1:1, and leaving
   * one is what Block is for.
   *
   * **Details and Add stand down while either reported write is out** (#257,
   * #258). Both switch the drawer to another `view`, which unmounts this one and
   * takes the error bar — the only renderer of a refused edit or a refused bulk
   * delete — with it. Absent rather than greyed, matching the way Delete leaves
   * the selection bar: `getActions` is called when the menu opens, so what it
   * offers is a fact about now.
   *
   * Mute stays because it doesn't change `view` at all. Leave stays because it
   * asks first and means it: someone who confirms "leave this chat" has decided
   * the chat is over, and holding that behind a typo correction would be the
   * gate outstaying its purpose.
   */
  function headerActions() {
    const actions = [
      ...(reportingWrite ? [] : [{ label: "Details", onClick: openInfo }]),
      {
        label: detail.muted ? "Unmute" : "Mute",
        onClick: () => muteMutation.mutate(!detail.muted),
      },
    ];
    if (isGroup) {
      if (!reportingWrite)
        actions.push({
          label: "Add people",
          onClick: () => openNew({ addToConversationId: conversationId }),
        });
      actions.push({
        label: "Leave chat",
        danger: true,
        onClick: () => {
          if (
            window.confirm(
              "Leave this chat? You’ll stop receiving messages here."
            )
          ) {
            leaveMutation.mutate();
          }
        },
      });
    }
    return actions;
  }

  /**
   * The same menu inside the strand, one item shorter (no Edit) and with Reply
   * re-aiming the strand's composer instead of opening anything — you're already
   * in the strand a reply-to-a-reply would land in, since the server flattens
   * every reply one level deep. See `MessageStrandPanel`.
   */
  const getStrandActions = (message) =>
    messageActions({
      message,
      mine: message.sender.id === me?.pk,
      canSend,
      allowEdit: false,
      now: Date.now(),
      onReply: (target) =>
        setStrand((open) => open && { ...open, replyToId: target.id }),
      onDelete: (messageId) => deleteMutation.mutate(messageId),
      onReport: (messageId) => setReportingId(messageId),
    });

  return (
    <>
      {/* Identity + `⋯`, since M9e. It used to carry Mute, Add and Leave as
          three icon buttons crowding the name of the person you're talking to,
          which is the one thing a chat header is for; they moved into the menu
          and onto the info panel behind it. */}
      <PanelHeader
        // Back stands down while selecting (M9f): leaving the thread isn't what
        // the arrow would mean in that moment, and Cancel — which is what you
        // actually want — takes its place on the other side of the count.
        onBack={selecting ? undefined : openList}
        actions={
          selecting ? (
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="btn btn-ghost btn-sm"
            >
              Cancel
            </button>
          ) : (
            !convoQuery.isError &&
            !isPending &&
            detail && (
              <DrawerMenu getActions={headerActions} label="Conversation options" />
            )
          )
        }
      >
        {/* Select mode takes the header over, exactly as it does on the phone:
            who you're talking to is not what you need while picking messages,
            and a count plus a way out is. The transcript below stays where it
            was — only the chrome around it changes. */}
        {selecting ? (
          // `role="status"` so the count is *announced* as it moves. Without it
          // the whole mode is silent to a screen reader: the header swapping and
          // a number going up are both purely visual events, and the count is
          // the only feedback a tick gets.
          <span
            role="status"
            className="font-display font-bold -tracking-[0.02em] text-ink"
          >
            {selected.size} selected
          </span>
        ) : convoQuery.isError ? (
          <span className="font-semibold text-ink">Conversation</span>
        ) : isGroup ? (
          <button
            type="button"
            onClick={openInfo}
            // The other way to the info panel, and it unmounts this view the
            // same way the menu item does — so it holds on the same condition
            // (#257, #258), for the same reason. Note this one is reachable
            // *during* a bulk delete in a way the menu item isn't obviously so:
            // `confirmDeleteSelected` clears the selection as soon as it fires,
            // which drops the header out of its "N selected" arm and puts this
            // button back on screen with the deletes still going.
            disabled={reportingWrite}
            className="flex min-w-0 items-center gap-2 text-left disabled:opacity-45"
            title="Conversation details"
          >
            <AvatarStack participants={participants} />
            <HeaderName name={detail.title || "Group chat"} muted={detail.muted} />
          </button>
        ) : other ? (
          // A 1:1's identity still goes to the *person*, not to the details:
          // their profile is what you want when you click a name, and the panel
          // is one item away in the menu beside it.
          <Link
            to={`/u/${other.id}`}
            className="flex min-w-0 items-center gap-2"
            title={`View ${other.display_name}’s profile`}
          >
            <Avatar user={other} size="sm" />
            <HeaderName name={other.display_name} muted={detail.muted} />
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
        // An open strand takes the panel (M9d). It doesn't sit beside the
        // transcript: a first cut widened the drawer to 740px so it could, and
        // that turned a companion to the timeline into something covering half
        // the window, which is the trade this panel exists not to make.
        //
        // **Hidden, not unmounted**, which is the part worth keeping. The
        // transcript holds a half-typed draft, an edit in progress, a latched
        // unread divider and a poll; a trip into a strand is supposed to cost
        // none of them, and M3 settled that replying must never disturb an edit.
        // `display: none` keeps all of it alive at the price of one thing —
        // scroll position, which a box with no layout can't hold, so closing a
        // strand lands you at the newest message rather than where you were
        // reading. That's the right way round: the newest message is where a
        // conversation resumes, and jump-to-latest exists for the other case.
        <div className="flex min-h-0 flex-1">
          <div className={`min-w-0 flex-1 flex-col ${strand ? "hidden" : "flex"}`}>
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
                          // Every action stands down in select mode (M9f) — the
                          // menu, the reaction row, and both ways into a strand.
                          // While selecting, a click on a message means one
                          // thing everywhere on screen, which is the same
                          // suspension of the one-gesture-per-target rule the
                          // app makes when its long-press menu steps aside.
                          getActions={selecting ? undefined : getActions}
                          onToggleSelect={
                            selecting && !outboxById.has(row.message.id)
                              ? () => toggleSelected(row.message.id)
                              : undefined
                          }
                          selected={!!selected?.has(row.message.id)}
                          mentionNames={mentionNames}
                          status={statusFor(row.message)}
                          meId={me?.pk}
                          // Both ways into the strand run through this one
                          // handler — the bubble itself once it wears a strand
                          // edge (M9g), and the reply count on a root. A reply
                          // aims the strand's composer at the root, since you
                          // came to read rather than to answer that one message.
                          onOpenThread={
                            selecting
                              ? undefined
                              : () =>
                                  openStrand(row.message, {
                                    aimAtRoot: !!row.message.reply_to,
                                  })
                          }
                          // False only for the bubble that replaces one of your
                          // own optimistic ones, which has already made its
                          // entrance — see `justSent`.
                          animate={!justSent.has(row.message.id)}
                          // Omitted in a thread you can no longer send to, which
                          // drops the menu's emoji row and "tap to remove" in the
                          // who-reacted list: a reaction is content everyone sees,
                          // so being severed stops it (403) exactly as it stops a
                          // message. The list stays readable, and inert.
                          // `mutateAsync`, so a refusal reaches the bubble that
                          // asked for it and gets said there (#251). `mutate`
                          // swallows it, and the mutation's own `isError` is no
                          // use to either call site: one mutation serves every
                          // bubble in the thread *and* every bubble in an open
                          // strand, so a flag on it can't say which tap failed
                          // — and the strand's are on screen while the
                          // transcript around this line is `hidden`.
                          onReact={
                            canSend && !selecting
                              ? (emoji) =>
                                  reactMutation.mutateAsync({
                                    messageId: row.message.id,
                                    emoji,
                                  })
                              : undefined
                          }
                          onRetry={() => {
                            const entry = outboxById.get(row.message.id);
                            if (entry) retrySend(entry);
                          }}
                          onDiscard={() => discardSend(row.message.id)}
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
              {/* While selecting, the composer's slot holds the bulk actions
                  instead (M9f) — the same place, so nothing moves, and there is
                  never both a composer and an action bar competing for the
                  bottom of the panel. */}
              {selecting ? (
                <div className="flex items-center justify-center gap-6 py-1">
                  <button
                    type="button"
                    onClick={copySelected}
                    disabled={selected.size === 0}
                    className="text-sm font-semibold text-accent-deep transition hover:underline disabled:text-ink-faint disabled:no-underline"
                  >
                    Copy
                  </button>
                  {/* Only when every ticked message is one you can delete — see
                      `deletableSelection`. Absent rather than disabled: a
                      permanently greyed Delete beside someone else's message
                      reads as a bug, where nothing at all reads as "not
                      yours". */}
                  {deletableSelection && (
                    <button
                      type="button"
                      onClick={confirmDeleteSelected}
                      className="text-sm font-semibold text-red-600 transition hover:underline"
                    >
                      Delete
                    </button>
                  )}
                </div>
              ) : canSend ? (
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
                      {/* Held while the save is out (#257) — same asymmetry the
                          rest of this family had, with Save gated and the ✕
                          next to it wide open. Leaving edit mode discards the
                          rejection (see `stopEditing`). */}
                      <button
                        type="button"
                        onClick={stopEditing}
                        disabled={editMutation.isPending}
                        aria-label="Cancel editing"
                        className="shrink-0 rounded-full px-1 text-ink-faint transition hover:text-ink disabled:opacity-45"
                      >
                        ✕
                      </button>
                    </div>
                  )}
                  {/* The photo waiting to go, or the moment it's being prepared
                      (M9e). Hidden while editing rather than dropped: an edit is
                      a `PATCH` of *text*, so it can't carry an attachment, and
                      throwing away a picture someone had queued because they
                      stopped to fix a typo would be the same small betrayal
                      `stashedDraft` exists to prevent. It comes back with the
                      draft when the edit ends. */}
                  {!editing && (preparing || attachment) && (
                    <div className="mb-2">
                      {preparing ? (
                        <div className="flex h-20 w-20 items-center justify-center rounded-xl border border-dashed border-line-strong text-xs text-ink-faint">
                          Preparing…
                        </div>
                      ) : (
                        <div className="relative inline-block">
                          <img
                            src={attachment.previewUrl}
                            alt="Photo to send"
                            className="h-20 w-20 rounded-xl object-cover"
                          />
                          <button
                            type="button"
                            onClick={removeAttachment}
                            aria-label="Remove photo"
                            className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-ink text-xs font-bold text-white shadow"
                          >
                            ×
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                  {/* Who you might be naming (M9f), directly above the input —
                      nearest the words being typed, and gone the moment there's
                      no `@` in progress.

                      Not offered while editing, for the same reason the attach
                      button isn't: an edit carries no `mention_ids`, so picking
                      someone here would do nothing at all — no notification, and
                      not even a highlight, since the highlight is driven by the
                      ids rather than by the words. A picker that silently does
                      nothing is worse than no picker. Adding a mention means
                      sending a message. */}
                  {!editing && (
                    <MentionSuggestions
                      people={mentions.suggestions}
                      onChoose={mentions.choose}
                    />
                  )}
                  <form onSubmit={handleSubmit} className="flex items-end gap-2">
                    {!editing && (
                      <>
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept="image/*"
                          onChange={handleFileChosen}
                          className="hidden"
                          data-testid="chat-photo-input"
                        />
                        {/* A bordered circle with a `+`, the same control the
                            app's composer uses — not a camera or a paperclip.
                            It adds *something* to the message, and there is one
                            thing it can add; naming the medium in the icon would
                            be a promise to change it the day there's a second. */}
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          disabled={preparing || !!attachment}
                          aria-label="Add a photo"
                          className="mb-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line-strong bg-raised text-ink-soft transition hover:border-accent hover:bg-accent-tint hover:text-accent-deep disabled:opacity-40"
                        >
                          {/* One photo per message — the server's cap, and the
                              better chat shape besides: each picture gets its
                              own bubble, and so its own reactions, replies and
                              delete. */}
                          <StrokeIcon path="M12 6v12 M6 12h12" size={18} />
                        </button>
                      </>
                    )}
                    <textarea
                      ref={inputRef}
                      value={text}
                      onChange={(e) =>
                        mentions.onChange(e.target.value, e.target.selectionStart)
                      }
                      // Where the caret is, which is what decides whether you're
                      // half-way through typing an `@name` *right now* (M9f).
                      onSelect={(e) =>
                        mentions.onCaretMove(e.target.selectionStart)
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          handleSubmit(e);
                        }
                        // Escape leaves edit mode rather than closing the drawer:
                        // the nearer thing wins, and losing the whole panel
                        // mid-correction would be a surprise.
                        //
                        // Except while the save is out (#257), when it does
                        // nothing at all: leaving edit mode throws the pending
                        // rejection away. The press is still swallowed — passing
                        // it on would reach the drawer's own Escape, which is
                        // the *bigger* version of the same mistake.
                        if (e.key === "Escape" && editing) {
                          e.preventDefault();
                          e.stopPropagation();
                          if (!editMutation.isPending) stopEditing();
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
                      // Only an *edit* blocks on its request. A send doesn't: the
                      // message is already on screen and the composer is already
                      // empty, so there's nothing to wait for. See `canSubmit`
                      // for why the two modes ask different questions.
                      disabled={!canSubmit}
                      className="btn btn-primary btn-sm mb-0.5"
                    >
                      {editing
                        ? editMutation.isPending
                          ? "Saving…"
                          : "Save"
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
              {/* A failed *send* is reported on its own bubble, not here (M9c) —
                  nearer the thing that went wrong, and the only place that works
                  when two messages are in flight and one of them fell over. A
                  failed edit has no bubble of its own, so it goes in the bar
                  below this column rather than inside it — see there for why. */}
              {/* A failed *reaction* isn't reported here either, and that was a
                  bug for as long as it was (#251): the composer sits in the
                  transcript column, which is given `hidden` whenever a strand is
                  open — and a strand is one of the two places you can react
                  from. Anything rendered here while one is open paints into a
                  `display: none` subtree. It says so on the bubble now, which
                  both ways in can see. */}
            </div>
          </div>

          {strand && (
            <MessageStrandPanel
              conversationId={conversationId}
              rootId={strand.rootId}
              replyToId={strand.replyToId}
              meId={me?.pk}
              isGroup={isGroup}
              canSend={canSend}
              mentionable={mentionable}
              mentionNames={mentionNames}
              onAimAt={(messageId) =>
                setStrand((open) => open && { ...open, replyToId: messageId })
              }
              // The strand's own unsent replies, so one appears the moment you
              // send it and a failed one is recoverable *here* — which matters
              // here, since the transcript holding the other copy is hidden
              // while a strand is open.
              outgoing={outbox
                .filter((entry) => entry.rootId === strand.rootId)
                .map((entry) => asMessage(entry, meAsAuthor))}
              statusFor={statusFor}
              justSent={justSent}
              getActions={getStrandActions}
              // Omitted in a thread you can no longer send to, exactly as in the
              // transcript: a reaction is content everyone sees, so being
              // severed stops it (403) as surely as it stops a message.
              onReact={
                canSend
                  ? (messageId, emoji) =>
                      reactMutation.mutateAsync({ messageId, emoji })
                  : undefined
              }
              onSend={(value, replyToId, mentionIds) =>
                queueSend(value, {
                  replyToId,
                  rootId: strand.rootId,
                  mentionIds,
                })
              }
              onRetry={(message) => {
                const entry = outboxById.get(message.id);
                if (entry) retrySend(entry);
              }}
              onDiscard={(message) => discardSend(message.id)}
              onClose={() => setStrand(null)}
            />
          )}
        </div>
      )}

      {/* The three failures with nowhere nearer to go, in a bar under whichever
          of the transcript and the strand is on screen.

          **They used to sit in the composer, and that was the bug (#253).** The
          composer belongs to the transcript column, which is given `hidden` — a
          real `display: none` — for as long as a strand is open, and neither
          the write nor the strand waits for the other. #251 checked that Edit
          and Select can't be *reached* from inside a strand (`getStrandActions`
          passes `allowEdit: false` and omits `onSelect`) and concluded these
          were safe; but that gates the trigger, and the `hidden` is on the
          renderer. A strand opened while one of them is still out hid the
          answer just the same — and for the bulk delete there wasn't even a
          race to win, since `confirmDeleteSelected` ends select mode on the
          line after `mutate()` while its DELETEs go out one at a time.

          So the fix is where they render, not who can reach what: out here they
          sit outside the column entirely — a sibling of the row that holds both
          it and the strand — and there is no longer a state of this view in
          which they paint into a hidden subtree. The invariant, stated as the
          class it is: **nothing in that column may be the only renderer of a
          write that can outlive the transcript being visible.** A `role="alert"`
          in a `display: none` subtree isn't announced either, so this was silent
          to a screen reader too.

          Kept out of the column, not merely conditioned on `!strand` — the
          message is worth *more* over an open strand, not less, because leaving
          the thread for the conversation list unmounts this view (`MessagesDrawer`
          renders it only while `view === "thread"`) and takes the message with
          it. That unmount was its own bug, #258, and #253 could only stop the
          *hiding*, not the *unmounting*: the drawer's Back, ✕ and Escape sit a
          level above this component and couldn't see a write in flight. They can
          now — `useHoldMessagesOpen` above tells them, for both writes in here,
          and they hold until the answer lands. */}
      {(photoError ||
        editMutation.isError ||
        deleteManyMutation.isError ||
        deleteMutation.isError ||
        leaveMutation.isError ||
        muteMutation.isError) && (
        <div className="space-y-1 px-3 pb-3 text-sm text-red-600">
          {/* A photo that couldn't be prepared never reached the outbox, so it
              has no bubble to fail on. Same window as the other two: preparing
              one is async (it's decoded and re-encoded to strip EXIF), and the
              transcript stays live while it runs. */}
          {photoError && <p role="alert">{photoError}</p>}
          {editMutation.isError && (
            <p role="alert">
              {serverMessage(editMutation.error, "Couldn’t save the edit.")}
            </p>
          )}
          {/* A bulk delete that fell over has no bubble to fail on and no mode
              left to report in — the selection ends the moment you confirm.
              Its own wording rather than the server's: a partial failure means
              *some* of them are still there, which is what you need to know and
              not what any one response says. */}
          {deleteManyMutation.isError && (
            <p role="alert">Some messages are still there. Try again.</p>
          )}
          {/* The three #238 additions. All of them said nothing at all when they
              failed, in a file where the two above already reported — omissions
              rather than a house style.

              **Single-message delete** is offered from the bubble's ⋯ and from
              inside a strand. The bubble simply stayed where it was, and the
              natural response is to delete it again — against a server that may
              well have succeeded the first time.

              **Leave.** `openList()` runs only on `onSuccess`, so a refused
              leave left you staring at the thread you'd just confirmed leaving.

              **Mute** is the one that lies hardest. The menu closes on the
              click, and the header's muted mark only appears once `detail.muted`
              comes back changed — which it won't, because the write failed. A
              mute that 500'd is pixel-identical to a mute that worked, so you
              believe a noisy group chat is silenced and your phone buzzes all
              evening. `ConversationListView` names this exact failure in its own
              comment and handles it; this view didn't. */}
          {deleteMutation.isError && (
            <p role="alert">
              {serverMessage(
                deleteMutation.error,
                "Couldn’t delete that message."
              )}
            </p>
          )}
          {leaveMutation.isError && (
            <p role="alert">
              {serverMessage(leaveMutation.error, "Couldn’t leave this chat.")}
            </p>
          )}
          {muteMutation.isError && (
            <p role="alert">
              {serverMessage(
                muteMutation.error,
                muteMutation.variables
                  ? "Couldn’t mute this chat."
                  : "Couldn’t unmute this chat."
              )}
            </p>
          )}
        </div>
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
