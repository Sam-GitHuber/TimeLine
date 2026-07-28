/**
 * A single conversation thread — 1:1 or group. Ported from the web's
 * `ConversationThreadView` (in `MessagesDrawer.jsx`), but a full-screen route
 * pushed over the tab bar rather than a drawer view (the E2 structure decision).
 *
 * What it does:
 *   - loads the conversation detail (the header identity + `can_send` +
 *     `my_status`, which the messages list doesn't carry) and the messages;
 *   - polls the messages on the fast cadence (`MESSAGE_POLL_MS`), and the
 *     detail on a slower one (`CONVERSATION_DETAIL_POLL_MS`) — that payload
 *     carries the read receipts, so a snapshot taken at mount would freeze
 *     every tick at "sent";
 *   - marks the thread read on open and as new messages land, clearing the
 *     per-thread pill and the tab badge;
 *   - sends, and offers the **long-press action menu** on any bubble — Copy /
 *     Edit / Delete on your own, Copy / Report on someone else's (Phase 9b M1),
 *     with a quick-reaction row across the top (Phase 9b M2);
 *   - a *group* header offers Leave; a 1:1 header links to the other's profile;
 *   - a **pending** viewer (added but not yet connected to the whole clique) sees
 *     the locked `PendingChatPanel` instead of the message list;
 *   - a viewer who can no longer send (disconnected) gets a read-only footer;
 *   - keeps the newest message in view.
 *
 * **Add people is E2b**, so a group header carries only Leave here; the composer
 * for a new chat and add-people land with the create half of E2.
 */

import type { InfiniteData } from '@tanstack/react-query';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import EmojiPicker from 'rn-emoji-keyboard';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  api,
  ApiError,
  CONVERSATION_DETAIL_POLL_MS,
  MESSAGE_EDIT_WINDOW_MS,
  MESSAGE_POLL_MS,
} from '@/api';
import { useAuth } from '@/auth';
import { Avatar } from '@/components/Avatar';
import { AvatarStack } from '@/components/AvatarStack';
import type { BubbleAnchor, MessageAction } from '@/components/MessageActionMenu';
import { MessageActionMenu } from '@/components/MessageActionMenu';
import { MessageBubble } from '@/components/MessageBubble';
import { MessageThreadView, threadQueryKey } from '@/components/MessageThreadView';
import { PendingChatPanel } from '@/components/PendingChatPanel';
import { ReactorsSheet, reactorsQueryKey } from '@/components/ReactorsSheet';
import { ReportModal } from '@/components/ReportModal';
import type { Outgoing } from '@/outbox';
import { asMessage, newOutgoing, updateOutbox, useOutbox } from '@/outbox';
import type { SendState } from '@/readReceipts';
import { readStateFor, receiptsVisible } from '@/readReceipts';
import {
  colors,
  emojiPickerTheme,
  fontSize,
  radius,
  spacing,
} from '@/theme';
import type { Author, Message, Paginated, Reaction } from '@/types';

/** The composer bar's base vertical padding, before the home-indicator inset. */
const COMPOSER_PAD = spacing.sm + 2;

/**
 * Write a message's fresh reaction summary into the cached thread.
 *
 * The toggle endpoint returns the target's whole updated aggregate, so there's
 * nothing to guess at — the pills re-render from server truth without waiting up
 * to `MESSAGE_POLL_MS` for the next poll.
 *
 * **No optimistic pre-tap update, deliberately.** The obvious next step is to
 * simulate the toggle locally before the response lands, but that means a second
 * copy of rules the server owns (the per-target emoji cap, emoji validation, the
 * count-then-emoji ordering) which would drift and show a pill that then
 * disappears. The round trip is one request against an already-open screen. The
 * phase plan's instruction is to *use* reactions for a week and see whether the
 * latency is actually noticeable before optimising for it — so this stays simple
 * until there's evidence, and optimistic writes land properly in M4.
 */
function patchReactions(
  data: InfiniteData<Paginated<Message>, string> | undefined,
  messageId: number,
  reactions: Reaction[]
) {
  if (!data?.pages) return data;
  return {
    ...data,
    pages: data.pages.map((page) =>
      // Rebuild only the page holding the message, so unrelated pages keep their
      // identity and don't re-render the whole thread on every reaction.
      page.results.some((m) => m.id === messageId)
        ? {
            ...page,
            results: page.results.map((m) =>
              m.id === messageId ? { ...m, reactions } : m
            ),
          }
        : page
    ),
  };
}

/** What one send needs to carry, including which outbox entry it belongs to. */
type SendVars = { value: string; replyToId?: number; tempId: number };

/**
 * Put an accepted message into the cached thread, if it isn't there already.
 *
 * Bridges the gap between "the POST returned" and "the refetch has landed": for
 * that second or two the outbox entry is gone and the poll hasn't run, so
 * without this the bubble would blink out and back. Appended to the last page
 * because the transcript is oldest-first and this is, by construction, the
 * newest thing in it.
 *
 * The guard matters — a poll can land *between* the response and this write, so
 * the message may already be present, and appending blind would show it twice.
 */
function appendMessage(
  data: InfiniteData<Paginated<Message>, string> | undefined,
  message: Message
) {
  if (!data?.pages.length) return data;
  if (data.pages.some((page) => page.results.some((m) => m.id === message.id))) {
    return data;
  }
  const pages = data.pages.map((page, index) =>
    index === data.pages.length - 1
      ? { ...page, results: [...page.results, message] }
      : page
  );
  return { ...data, pages };
}

/**
 * What the long-press menu offers for one message.
 *
 * A plain function of its inputs (`now` is passed in, not read) so it's decided
 * at press time rather than at render time — one of the entries expires, and a
 * menu whose contents depend on when React last redrew would be a subtle bug.
 * Built as **data** so M2 (react) and M3 (reply) can slot their entries in
 * without turning the thread screen into a JSX thicket.
 *
 * Edit appears only on your own message, only inside the edit window, and only
 * while you can still send here. The server enforces all three independently;
 * this just avoids offering an action that's going to come back 403.
 */
function messageActions({
  message,
  mine,
  canSend,
  now,
  onReply,
  onEdit,
  onDelete,
  onReport,
}: {
  message: Message;
  mine: boolean;
  canSend: boolean;
  now: number;
  onReply: (message: Message) => void;
  onEdit: (message: Message) => void;
  onDelete: (messageId: number) => void;
  onReport: (messageId: number) => void;
}): MessageAction[] {
  const actions: MessageAction[] = [
    {
      label: 'Copy',
      // Swallow a pasteboard failure rather than leaving a floating rejection:
      // there's nothing useful to tell someone whose copy didn't take, and an
      // unhandled rejection is a redbox in dev.
      onPress: () => {
        Clipboard.setStringAsync(message.text).catch(() => {});
      },
    },
  ];
  // The only way to reply (M3). A swipe-to-reply shipped alongside this and was
  // removed — it raced the navigator's back gesture and usually lost, closing
  // the conversation instead of starting a reply; see `MessageBubble`. Left out
  // where the server would refuse the send anyway, like the reaction row.
  if (canSend) {
    actions.push({ label: 'Reply', onPress: () => onReply(message) });
  }
  if (mine) {
    const age = now - new Date(message.created_at).getTime();
    if (canSend && age < MESSAGE_EDIT_WINDOW_MS) {
      actions.push({ label: 'Edit', onPress: () => onEdit(message) });
    }
    actions.push({
      label: 'Delete',
      destructive: true,
      onPress: () => onDelete(message.id),
    });
  } else {
    actions.push({ label: 'Report', onPress: () => onReport(message.id) });
  }
  return actions;
}

export default function ThreadScreen() {
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const id = Number(conversationId);
  const { user: me } = useAuth();
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const listRef = useRef<FlatList<Message>>(null);
  const inputRef = useRef<TextInput>(null);

  // The long-pressed bubble, where it sits on screen, and what the menu offers
  // for it. Null = no menu open. The actions are decided *at press time* rather
  // than during render, because one of them depends on the clock (Edit expires
  // 15 minutes after sending) and a render-time `Date.now()` would make the
  // component's output depend on when React happened to redraw it.
  const [menuTarget, setMenuTarget] = useState<{
    message: Message;
    mine: boolean;
    anchor: BubbleAnchor;
    actions: MessageAction[];
  } | null>(null);
  // The message being corrected, if any — the composer doubles as the editor.
  const [editing, setEditing] = useState<Message | null>(null);
  /**
   * The open focused thread, or null for the transcript (M3).
   *
   * **Replying always opens the strand**, rather than aiming the transcript's
   * composer at a message — even when the message has no replies yet and the
   * strand is one bubble long. You reply *inside* the conversation you're
   * joining, so the context you're answering is on screen while you type it,
   * which was the whole reason for building the focused view. It also leaves the
   * transcript's composer doing exactly two things (write, edit) instead of
   * three.
   *
   * `replyToId` is the message you actually tapped Reply on, which is only the
   * root when you got here by browsing — see `MessageThreadView`.
   */
  const [thread, setThread] = useState<{
    rootId: number;
    replyToId: number;
    /** Reply put you here, so the keyboard should already be up. */
    composing: boolean;
  } | null>(null);
  // Whatever was half-typed when edit mode started, put back on cancel. Losing
  // a draft to a typo fix would be its own small betrayal.
  const [stashedDraft, setStashedDraft] = useState('');
  const [reportingId, setReportingId] = useState<number | null>(null);
  /**
   * Messages sent but not yet accepted by the server (M4). Rendered after the
   * loaded ones, oldest-first like everything else. See `outbox.ts` for why this
   * isn't an optimistic write into the query cache — and why it's a store
   * outside this component rather than `useState`: as screen state it was thrown
   * away by tapping back, which silently lost exactly the failed message the
   * outbox exists to hold on to.
   */
  const outbox = useOutbox(id);
  const setOutbox = useCallback(
    (update: (entries: Outgoing[]) => Outgoing[]) => updateOutbox(id, update),
    [id]
  );
  // The message whose full emoji grid is open, and the one whose reactor list is.
  // Both are separate from `menuTarget` because the menu closes on its way into
  // either — `rn-emoji-keyboard` is itself a Modal, and two visible modals stack
  // badly on iOS (the trap `ReactionTray` documents).
  const [pickerFor, setPickerFor] = useState<number | null>(null);
  const [reactorsFor, setReactorsFor] = useState<number | null>(null);

  const goBack = () =>
    router.canGoBack() ? router.back() : router.replace('/messages');

  /**
   * The thread's header, membership — and, since M4, the participants' read
   * markers, which is why this is **polled and not merely fetched on mount**.
   *
   * `last_read_at` read once at mount is by construction older than every
   * message you send afterwards, so a snapshot can only ever say "sent" about
   * the message you're actually watching. The second tick would appear only
   * after leaving the thread and coming back, which is the one moment nobody is
   * looking. Slower than the message poll deliberately — see
   * `CONVERSATION_DETAIL_POLL_MS`.
   *
   * It runs while you're pending too, and usefully: the locked panel lifts by
   * itself when the last person accepts, rather than waiting for a manual
   * reopen.
   */
  const convoQuery = useQuery({
    queryKey: ['conversation', id],
    queryFn: () => api.getConversation(id),
    refetchInterval: CONVERSATION_DETAIL_POLL_MS,
  });
  const detail = convoQuery.data;
  const isGroup = detail?.kind === 'group';
  // A pending member can't read or send — the messages endpoint 403s — so the
  // thread is replaced by PendingChatPanel below rather than fetching a list it
  // can't have.
  const isPending = detail?.my_status === 'pending';
  const canSend = detail?.can_send ?? false;

  // Pull every message page (threads are short at family scale) so the newest is
  // always on screen, and poll so incoming messages appear without a reload.
  const messagesQuery = useInfiniteQuery({
    queryKey: ['messages', id],
    queryFn: ({ pageParam }) =>
      pageParam ? api.getPage<Message>(pageParam) : api.getMessages(id),
    initialPageParam: '' as string,
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
    refetchInterval: MESSAGE_POLL_MS,
    enabled: !!detail && !isPending,
  });
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = messagesQuery;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const loaded = messagesQuery.data?.pages.flatMap((page) => page.results) ?? [];
  const messageCount = loaded.length;

  /**
   * What the list renders: everything the server has, then everything it
   * doesn't yet (M4). Concatenating rather than merging by timestamp is
   * correct *and* simpler — an unsent message is by definition newer than every
   * accepted one, since it hasn't been accepted.
   */
  const meAsAuthor: Author = {
    id: me?.pk ?? -1,
    display_name: me?.display_name ?? '',
    avatar_thumb: me?.avatar_thumb ?? null,
  };
  const messages = [
    ...loaded,
    ...outbox.map((entry) => asMessage(entry, meAsAuthor)),
  ];
  const outboxById = new Map(outbox.map((entry) => [entry.tempId, entry]));

  /**
   * Read receipts (M4) — the participants carry them, so the ticks come from
   * the *detail* query, not the message list.
   *
   * `showReceipts` being false means **you** turned them off, and the whole
   * column of ticks disappears rather than freezing on "sent": a permanent
   * single tick would read as "nobody is ever reading these", where showing
   * nothing says the true thing, which is that you asked out of this.
   */
  const participants = detail?.participants ?? [];
  const showReceipts = receiptsVisible(participants);

  /**
   * The tick (or clock) for one bubble — the single answer for both the
   * transcript and the strand, so a reply can't show one state in one place and
   * another in the other.
   *
   * Never on someone else's message: a tick reports what *your* message did.
   */
  function statusFor(message: Message): SendState | undefined {
    if (message.sender.id !== me?.pk) return undefined;
    const pending = outboxById.get(message.id);
    if (pending) return pending.status;
    if (!showReceipts) return undefined;
    return readStateFor(message, participants, me?.pk);
  }

  /** Give up on a failed send. The only way outbox text is ever thrown away. */
  function discardSend(message: Message) {
    setOutbox((entries) => entries.filter((e) => e.tempId !== message.id));
  }

  /** Send a failed message again, from either the transcript or a strand. */
  function retryMessage(message: Message) {
    const entry = outboxById.get(message.id);
    if (entry) retrySend(entry);
  }

  /**
   * Resolve a quoted message from what we've already loaded (M3).
   *
   * 🔒 Nothing about the quoted message is sent with the reply — it carries a
   * bare `{ id }`, not the text and not the author — so both have to be found in
   * messages that came through the interval-clipped endpoint. That's the point:
   * a quote can't show what the thread wouldn't. A miss therefore renders
   * "Original message unavailable" with no name above it, which today means
   * genuinely clipped, because this screen still loads every page.
   *
   * **M5 has to revisit this.** It replaces the eager full-history load with
   * proper upward paging, at which point a miss will also mean "not paged in
   * yet" and the honest message becomes a lie some of the time. The fix is a
   * fetch through the same clipped endpoint (which is what the focused thread
   * view already does), not a wider payload.
   *
   * Built from `loaded` and not `messages`: an outbox entry has no server id, so
   * nothing can be quoting it yet.
   */
  const messagesById = new Map(loaded.map((m) => [m.id, m]));

  // Mark read on open and as new messages land, clearing the tab badge and this
  // thread's pill. Guarded on error so a failed load doesn't clear the badge.
  useEffect(() => {
    if (convoQuery.isError || isPending) return;
    api.markConversationRead(id).then(() => {
      queryClient.invalidateQueries({ queryKey: ['unreadMessages'] });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    });
  }, [id, messageCount, convoQuery.isError, isPending, queryClient]);

  /**
   * Send one message and settle its outbox entry.
   *
   * These handlers are safe to leave on the mutation even though the outbox now
   * outlives the screen: TanStack captures a mutation's options when it starts,
   * so `onSuccess`/`onError` still run if you navigate away mid-send. Tapping
   * back on a message in flight settles it exactly as staying would — which
   * matters more than it used to, because a stranded entry would now persist
   * rather than dying with the component.
   */
  const sendMutation = useMutation({
    mutationFn: ({ value, replyToId }: SendVars) =>
      api.sendMessage(id, value, replyToId),
    onSuccess: (message, { tempId }) => {
      // Write the accepted message into the cache *before* dropping the outbox
      // entry, so the bubble is never absent for the frame between the two.
      // React batches both, but the ordering is what makes that true rather
      // than incidental.
      queryClient.setQueryData<InfiniteData<Paginated<Message>, string>>(
        ['messages', id],
        (cached) => appendMessage(cached, message)
      );
      // And into the strand it belongs to, if it's a reply. The focused view
      // reads its own query, so without this a reply sent from in there blinks
      // out of the strand between the response landing and the refetch below
      // coming back — the very flicker the write above exists to prevent, just
      // in the other view. `thread_root_id` comes off the server's copy rather
      // than the client's guess: the server decides which strand a reply
      // flattens into.
      if (message.thread_root_id) {
        queryClient.setQueryData<InfiniteData<Paginated<Message>, string>>(
          threadQueryKey(id, message.thread_root_id),
          (cached) => appendMessage(cached, message)
        );
      }
      setOutbox((entries) => entries.filter((e) => e.tempId !== tempId));
      // **The composer is not touched here** — it was cleared the moment the
      // message went into the outbox. Clearing on the response was right when
      // the response was the first sign anything had happened; now it would
      // wipe whatever you'd started typing in the seconds since, which is the
      // exact draft-loss `stashedDraft` exists to prevent, just triggered by
      // your own previous message landing.
      queryClient.invalidateQueries({ queryKey: ['messages', id] });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      // The focused view reads its own query, so a reply sent from in there has
      // to refresh it — otherwise the strand you're looking at is a poll cycle
      // behind the transcript underneath it, and the reply you just sent
      // wouldn't appear in the very view you sent it from.
      queryClient.invalidateQueries({ queryKey: ['thread', id] });
    },
    // The message stays put and goes to `failed`; the bubble grows Retry and
    // Discard. Nothing is thrown away, and there's no alert — the failure is
    // already visible on the thing that failed, which is a better place to say
    // it than a modal you have to dismiss before you can act.
    onError: (_error, { tempId }) =>
      setOutbox((entries) =>
        entries.map((e) =>
          e.tempId === tempId ? { ...e, status: 'failed' as const } : e
        )
      ),
  });

  /**
   * Send, showing the message immediately (M4).
   *
   * Everything that sends in this screen goes through here — the composer and
   * the strand alike — so there's one place that knows an unsent message exists
   * and one place that decides what happens when it doesn't land.
   */
  function queueSend({
    value,
    replyToId,
    rootId,
  }: {
    value: string;
    replyToId?: number;
    rootId?: number;
  }) {
    const entry = newOutgoing({ text: value, replyToId, rootId });
    setOutbox((entries) => [...entries, entry]);
    return sendMutation.mutateAsync({
      value,
      replyToId,
      tempId: entry.tempId,
    });
  }

  function retrySend(entry: Outgoing) {
    setOutbox((entries) =>
      entries.map((e) =>
        e.tempId === entry.tempId ? { ...e, status: 'sending' as const } : e
      )
    );
    // Swallowed because the mutation's own `onError` has already put the entry
    // back into `failed` — the rejection here is the same failure a second
    // time, and letting it float would be an unhandled rejection for nothing.
    sendMutation
      .mutateAsync({
        value: entry.text,
        replyToId: entry.replyToId,
        tempId: entry.tempId,
      })
      .catch(() => {});
  }

  const deleteMutation = useMutation({
    mutationFn: (messageId: number) => api.deleteMessage(id, messageId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['messages', id] });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });

  const editMutation = useMutation({
    mutationFn: ({ messageId, value }: { messageId: number; value: string }) =>
      api.editMessage(id, messageId, value),
    onSuccess: () => {
      stopEditing();
      queryClient.invalidateQueries({ queryKey: ['messages', id] });
      // The list preview reads the latest message's text, so a correction to the
      // most recent message has to refresh it — even though an edit deliberately
      // doesn't reorder the list.
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });

  const reactMutation = useMutation({
    mutationFn: ({ messageId, emoji }: { messageId: number; emoji: string }) =>
      api.toggleReaction({ messageId, emoji }),
    onSuccess: (data, { messageId }) => {
      queryClient.setQueryData<InfiniteData<Paginated<Message>, string>>(
        ['messages', id],
        (cached) => patchReactions(cached, messageId, data.reactions ?? [])
      );
      // The reactor list is a *separate* cache that outlives the sheet, so it
      // has to be dealt with too — otherwise the next open renders the
      // pre-toggle list, and because that list is actionable, a row still
      // saying "Tap to remove" for a reaction you already removed would toggle
      // it straight back on.
      //
      // `removeQueries`, not `invalidateQueries`: the sheet is closed by now, so
      // the query is *inactive* and invalidation would only mark it stale —
      // reopening would still render the stale rows for the length of a round
      // trip, which is exactly the window in which they can be tapped. Dropping
      // the entry means the next open has nothing to show but a spinner, and
      // there is no moment where a wrong row is actionable. The toggle response
      // carries the aggregate, not the reactor list, so there's nothing better
      // to write in its place.
      queryClient.removeQueries({ queryKey: reactorsQueryKey({ messageId }) });
    },
    // Reacting is a one-tap gesture, so a failure has to say so rather than
    // leave the tap looking as though it worked. The server owns the rules that
    // can reject one (the per-target cap, emoji validation, a closed thread), so
    // its message is what gets shown — same as the feed's ReactionBar.
    onError: (error) =>
      Alert.alert(
        'Couldn’t react',
        error instanceof Error ? error.message : 'Something went wrong.'
      ),
  });

  const muteMutation = useMutation({
    mutationFn: (muted: boolean) => api.setConversationMuted(id, muted),
    onSuccess: () => {
      // The detail query holds `muted`, and the list shows it too, so both are
      // refetched rather than patched — a mute is a rare, deliberate tap, so
      // correctness is worth more here than saving a round-trip.
      queryClient.invalidateQueries({ queryKey: ['conversation', id] });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });

  const leaveMutation = useMutation({
    mutationFn: () => api.leaveConversation(id),
    onSuccess: () => {
      // Drop the just-left chat off the list (and its unread out of the tab
      // badge) immediately, rather than waiting up to a poll cycle for it.
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      queryClient.invalidateQueries({ queryKey: ['unreadMessages'] });
      goBack();
    },
  });

  /**
   * Only an *edit* blocks the composer now (M4).
   *
   * Sending used to disable it until the round trip finished, which meant firing
   * off two quick messages made you wait for the first — the single most
   * noticeable way a polling app feels slower than it is. With an outbox there's
   * nothing to wait for: each send gets its own entry and they land in the order
   * the server accepts them. An edit still blocks, because it targets one
   * specific message and two saves racing on it would be genuinely ambiguous.
   */
  const busy = editMutation.isPending;

  /**
   * Send a new message, or save the one being edited — the transcript's composer
   * does both. Replies are sent from inside the focused thread, not from here.
   */
  function handleSend() {
    const value = text.trim();
    if (!value || busy) return;
    if (editing) {
      // Saving the original text unchanged is a no-op, not a pointless PATCH
      // that would stamp the message "Edited" for nothing.
      if (value === editing.text) stopEditing();
      else editMutation.mutate({ messageId: editing.id, value });
      return;
    }
    // Clear the composer *now*, not on the response: the message is already on
    // screen as a bubble, so leaving the text sitting in the input as well
    // would read as though the send hadn't happened. A failure puts it back in
    // front of you as a failed bubble with Retry, which is a better home for it
    // than a composer you'd have to remember to re-send from.
    setText('');
    queueSend({ value }).catch(() => {});
  }

  function startEditing(message: Message) {
    // Only stash on the way *into* edit mode. Switching straight from editing
    // one message to another would otherwise overwrite the draft with the first
    // message's text — losing the very thing the stash exists to protect.
    if (!editing) setStashedDraft(text);
    setEditing(message);
    setText(message.text);
    editMutation.reset();
    // Focus after the composer has re-rendered into edit mode.
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  /**
   * Reply to a message (M3) — from the long-press menu's Reply, the only route.
   *
   * Opens the strand rather than aiming this screen's composer at the message,
   * so you can read what you're joining while you write. A message with no
   * replies yet opens a strand one bubble long, which is the point: the thread
   * is where a reply lives, whether or not one exists yet.
   *
   * `rootId` is the thread's head, `replyToId` the message actually tapped — the
   * two differ when you reply to something that's already a reply, and keeping
   * both is what lets the quote name who you answered rather than who started
   * the strand.
   */
  function startReplying(message: Message) {
    setThread({
      rootId: message.thread_root_id ?? message.id,
      replyToId: message.id,
      composing: true,
    });
  }

  /** Leave edit mode and put the pre-edit draft back in the composer. */
  function stopEditing() {
    setEditing(null);
    setText(stashedDraft);
    setStashedDraft('');
    // Clear any failed-edit error with the mode that produced it, or it lingers
    // over a composer that's no longer editing anything.
    editMutation.reset();
  }

  /**
   * Dismiss the emoji grid and the menu it was opened from, in that order.
   *
   * The menu is only *hidden* while the grid is up (see its `visible` prop), so
   * something has to unmount it afterwards or the thread stays dimmed behind an
   * invisible modal. Both happen in one commit, which is safe in this direction:
   * the menu is already hidden, so nothing is being torn down mid-presentation.
   */
  function closePicker() {
    setPickerFor(null);
    setMenuTarget(null);
  }

  function confirmDelete(messageId: number) {
    Alert.alert('Delete message?', 'This can’t be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => deleteMutation.mutate(messageId),
      },
    ]);
  }

  function confirmLeave() {
    Alert.alert('Leave chat?', 'You’ll stop receiving messages here.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: () => leaveMutation.mutate(),
      },
    ]);
  }

  const other = detail?.other;
  const loadError = convoQuery.isError;
  const notAvailable =
    convoQuery.error instanceof ApiError && convoQuery.error.status === 404;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.topBar}>
        <Pressable
          onPress={goBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={8}
        >
          <Text style={styles.back}>← Back</Text>
        </Pressable>

        <View style={styles.identity}>
          {loadError ? (
            <Text style={styles.headerName}>Conversation</Text>
          ) : isGroup ? (
            <View style={styles.headerRow}>
              <AvatarStack participants={detail.participants} />
              <Text style={styles.headerName} numberOfLines={1}>
                {detail.title || 'Group chat'}
              </Text>
            </View>
          ) : other ? (
            <Pressable
              onPress={() => router.push(`/u/${other.id}`)}
              accessibilityRole="button"
              accessibilityLabel={`View ${other.display_name}’s profile`}
              style={styles.headerRow}
            >
              <Avatar user={other} size="sm" />
              <Text style={styles.headerName} numberOfLines={1}>
                {other.display_name}
              </Text>
            </Pressable>
          ) : (
            <Text style={styles.headerLoading}>Loading…</Text>
          )}
        </View>

        {!loadError && !isPending && detail ? (
          <View style={styles.headerActions}>
            {/* Mute is offered on every thread, direct or group — a chatty 1:1
                is as worth silencing as a busy group. It's the current state as
                much as the action, so the label reads as the state ("Muted")
                once set rather than staying an imperative. */}
            <Pressable
              onPress={() => muteMutation.mutate(!detail.muted)}
              disabled={muteMutation.isPending}
              accessibilityRole="switch"
              accessibilityLabel="Mute notifications"
              accessibilityState={{ checked: detail.muted }}
              hitSlop={8}
            >
              <Text
                style={detail.muted ? styles.headerActionOn : styles.headerAction}
              >
                {detail.muted ? 'Muted' : 'Mute'}
              </Text>
            </Pressable>
            {isGroup ? (
              <>
                <Pressable
                  onPress={() => router.push(`/messages/new?addTo=${id}`)}
                  accessibilityRole="button"
                  accessibilityLabel="Add people"
                  hitSlop={8}
                >
                  <Text style={styles.headerAction}>Add</Text>
                </Pressable>
                <Pressable
                  onPress={confirmLeave}
                  accessibilityRole="button"
                  accessibilityLabel="Leave chat"
                  hitSlop={8}
                >
                  <Text style={styles.leave}>Leave</Text>
                </Pressable>
              </>
            ) : null}
          </View>
        ) : (
          // A fixed-width spacer keeps the identity block centred against the
          // Back button whether or not header actions are present.
          <View style={styles.actionSpacer} />
        )}
      </View>

      {loadError ? (
        <View style={styles.centre}>
          <Text style={styles.emptyTitle}>
            {notAvailable
              ? 'This conversation isn’t available.'
              : 'Couldn’t load this conversation.'}
          </Text>
          <Pressable
            onPress={goBack}
            accessibilityRole="button"
            style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
          >
            <Text style={styles.retryText}>Back to messages</Text>
          </Pressable>
        </View>
      ) : isPending ? (
        <PendingChatPanel
          mustConnectWith={detail.must_connect_with}
          conversationId={id}
          onLeave={goBack}
        />
      ) : (
        <KeyboardAvoidingView
          style={styles.fill}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(m) => String(m.id)}
            // `flex: 1` constrains the list to the gap between the header and the
            // composer. Without it a FlatList sizes to its content, so the newest
            // messages run *under* the composer and scrollToEnd lands them partly
            // hidden — you'd have to nudge the thread up to read the last one.
            style={styles.list}
            contentContainerStyle={styles.messagesContent}
            // Messages arrive oldest-first; keep the newest in view as they land
            // and on first layout.
            onContentSizeChange={() =>
              listRef.current?.scrollToEnd({ animated: false })
            }
            renderItem={({ item, index }) => {
              const mine = item.sender.id === me?.pk;
              // A run = consecutive messages from one sender; only the run's
              // first bubble is attributed (group threads only). A deleted
              // message still starts a run, so its tombstone stays attributed.
              const startsRun =
                messages[index - 1]?.sender.id !== item.sender.id;
              const pending = outboxById.get(item.id);
              return (
                <MessageBubble
                  message={item}
                  mine={mine}
                  showSender={isGroup && !mine && startsRun}
                  quoted={
                    item.reply_to ? messagesById.get(item.reply_to.id) : undefined
                  }
                  status={statusFor(item)}
                  onRetry={pending ? () => retryMessage(item) : undefined}
                  onDiscard={pending ? () => discardSend(item) : undefined}
                  onShowReactors={() => setReactorsFor(item.id)}
                  // Browsing into the strand rather than replying to a
                  // particular message, so the composer aims at the root. The
                  // thread's *root*, not the bubble you tapped: a root opens its
                  // own strand, a reply opens the one it belongs to. The server
                  // owns the flattening, so this is a read of it, never a second
                  // copy of the rule.
                  onOpenThread={() => {
                    const rootId = item.thread_root_id ?? item.id;
                    setThread({ rootId, replyToId: rootId, composing: false });
                  }}
                  // No menu on an unsent message: every action it offers —
                  // edit, delete, react, report — needs a server id this one
                  // hasn't got. Retry and Discard are on the bubble instead.
                  onLongPress={
                    pending
                      ? undefined
                      : (anchor) =>
                          setMenuTarget({
                            message: item,
                            mine,
                            anchor,
                            actions: messageActions({
                              message: item,
                              mine,
                              canSend,
                              now: Date.now(),
                              onReply: startReplying,
                              onEdit: startEditing,
                              onDelete: confirmDelete,
                              onReport: setReportingId,
                            }),
                          })
                  }
                />
              );
            }}
            ListEmptyComponent={
              messagesQuery.isLoading ? (
                <ActivityIndicator color={colors.accent} style={styles.spinner} />
              ) : (
                <Text style={styles.emptyThread}>No messages yet — say hello.</Text>
              )
            }
          />

          {/* Pad the bar past the home-indicator inset so the composer and Send
              button clear the bottom edge / swipe area on full-screen phones. On
              a home-button phone `insets.bottom` is 0, so this is the base pad.
              When the keyboard is up, KeyboardAvoidingView lifts the whole bar
              above it, and this inset becomes a small, harmless gap. */}
          <View
            style={[
              styles.composerBar,
              { paddingBottom: COMPOSER_PAD + insets.bottom },
            ]}
          >
            {canSend ? (
              <>
                {/* Edit mode says plainly what's being changed and offers an
                    obvious way out. Cancelling restores the draft you were
                    typing — and because an empty composer just disables Send,
                    there's no path from "editing" to an accidental delete. */}
                {editing ? (
                  <View style={styles.editingBar}>
                    <View style={styles.editingText}>
                      <Text style={styles.editingLabel}>Editing message</Text>
                      <Text style={styles.editingOriginal} numberOfLines={1}>
                        {editing.text}
                      </Text>
                    </View>
                    <Pressable
                      onPress={stopEditing}
                      accessibilityRole="button"
                      accessibilityLabel="Cancel editing"
                      hitSlop={8}
                    >
                      <Text style={styles.editingCancel}>✕</Text>
                    </Pressable>
                  </View>
                ) : null}

                <View style={styles.composer}>
                  <TextInput
                    ref={inputRef}
                    value={text}
                    onChangeText={setText}
                    placeholder="Write a message…"
                    placeholderTextColor={colors.inkFaint}
                    multiline
                    style={styles.input}
                    accessibilityLabel="Message"
                  />
                  <Pressable
                    onPress={handleSend}
                    disabled={!text.trim() || busy}
                    accessibilityRole="button"
                    accessibilityLabel={editing ? 'Save' : 'Send'}
                    style={({ pressed }) => [
                      styles.send,
                      (!text.trim() || busy) && styles.sendDisabled,
                      pressed && styles.pressed,
                    ]}
                  >
                    {/* No "Sending…" state any more: the message is already a
                        bubble in the thread wearing a clock, so the button
                        saying so as well would be the same news twice — and it
                        has to stay tappable for the next message anyway. */}
                    <Text style={styles.sendLabel}>
                      {editing
                        ? editMutation.isPending
                          ? 'Saving…'
                          : 'Save'
                        : 'Send'}
                    </Text>
                  </Pressable>
                </View>
              </>
            ) : (
              <Text style={styles.readonly}>
                You’re no longer connected with{' '}
                {other?.display_name ?? 'this person'}, so you can’t send new
                messages.
              </Text>
            )}
            {/* A failed send no longer reports itself down here. It reports on
                the bubble that failed, next to Retry and Discard — which is
                both nearer the thing that went wrong and the only place that
                works once several messages are in flight and only one of them
                fell over. */}
            {/* An edit can fail for a reason the menu couldn't rule out — most
                likely the 15-minute window closing while the menu was open — so
                say so rather than silently leaving edit mode on. */}
            {editMutation.isError && (
              <Text style={styles.sendError}>
                {editMutation.error instanceof Error
                  ? editMutation.error.message
                  : "Couldn't save the edit. Try again."}
              </Text>
            )}
          </View>
        </KeyboardAvoidingView>
      )}

      {/* The focused thread (M3). Mounted at screen level, over everything —
          it blurs the transcript rather than replacing it, because you haven't
          left the conversation, only narrowed to a strand of it. Both replying
          and browsing land here; `composing` is the difference. */}
      {thread ? (
        <MessageThreadView
          conversationId={id}
          rootId={thread.rootId}
          replyToId={thread.replyToId}
          composing={thread.composing}
          meId={me?.pk}
          isGroup={isGroup}
          canSend={canSend}
          // The strand's own unsent replies, so a reply appears the moment you
          // send it and a failed one is recoverable *here* rather than only in
          // the transcript behind the blur.
          outgoing={outbox
            .filter((entry) => entry.rootId === thread.rootId)
            .map((entry) => asMessage(entry, meAsAuthor))}
          statusFor={statusFor}
          onRetry={retryMessage}
          onDiscard={discardSend}
          // Replies go through the same outbox as everything else (M4), so a
          // reply that fails is a failed bubble in the transcript with Retry on
          // it, rather than text that existed only inside a view you've since
          // closed. `mutateAsync` still, so the strand can keep what you wrote
          // if the send doesn't land while you're looking at it.
          onSend={(value, replyToId) =>
            queueSend({ value, replyToId, rootId: thread.rootId })
          }
          onClose={() => setThread(null)}
        />
      ) : null}

      {menuTarget ? (
        <MessageActionMenu
          message={menuTarget.message}
          mine={menuTarget.mine}
          anchor={menuTarget.anchor}
          actions={menuTarget.actions}
          quoted={
            menuTarget.message.reply_to
              ? messagesById.get(menuTarget.message.reply_to.id)
              : undefined
          }
          onReact={
            canSend
              ? (emoji) =>
                  reactMutation.mutate({
                    messageId: menuTarget.message.id,
                    emoji,
                  })
              : undefined
          }
          onMoreEmoji={
            canSend ? () => setPickerFor(menuTarget.message.id) : undefined
          }
          // Hidden, not unmounted, while the emoji grid is up — tearing a
          // presented modal down in the same commit that presents the next one
          // is the iOS trap `ReactionTray` already documents. `closePicker`
          // below unmounts it once nothing else is on screen.
          visible={pickerFor == null}
          onClose={() => setMenuTarget(null)}
        />
      ) : null}

      {/* "Any emoji from your keyboard" stays true here too — the same picker the
          feed's ReactionTray opens, so the two clients' reaction sets can't
          diverge. Rendered at screen level so it isn't nested in the menu. */}
      <EmojiPicker
        open={pickerFor != null}
        onClose={closePicker}
        onEmojiSelected={(picked: { emoji: string }) => {
          if (pickerFor != null) {
            reactMutation.mutate({ messageId: pickerFor, emoji: picked.emoji });
          }
          closePicker();
        }}
        enableSearchBar
        theme={emojiPickerTheme}
      />

      {reactorsFor != null ? (
        <ReactorsSheet
          visible
          messageId={reactorsFor}
          meId={me?.pk}
          // Taking your reaction off is one of the two ways out (the other being
          // the menu's emoji row), so the sheet needs to be able to do it — but
          // only where you could add one in the first place. In a thread you've
          // been disconnected from the list stays readable and inert, which is
          // the same line the server draws.
          onRemoveReaction={
            canSend
              ? (emoji) =>
                  reactMutation.mutate({ messageId: reactorsFor, emoji })
              : undefined
          }
          onClose={() => setReactorsFor(null)}
        />
      ) : null}

      {reportingId != null ? (
        <ReportModal
          messageId={reportingId}
          onClose={() => setReportingId(null)}
        />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  fill: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  back: { fontSize: fontSize.sm, color: colors.inkFaint, fontWeight: '600' },
  identity: { flex: 1, alignItems: 'center' },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    maxWidth: '100%',
  },
  headerName: {
    flexShrink: 1,
    fontSize: fontSize.base,
    fontWeight: '700',
    color: colors.ink,
  },
  headerLoading: { fontSize: fontSize.sm, color: colors.inkFaint },
  leave: { fontSize: fontSize.sm, color: colors.danger, fontWeight: '600' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  headerAction: { fontSize: fontSize.sm, color: colors.accent, fontWeight: '600' },
  // The "on" state of a toggling header action: dimmed rather than accented,
  // because a muted thread is the quiet state and shouldn't draw the eye.
  headerActionOn: {
    fontSize: fontSize.sm,
    color: colors.inkFaint,
    fontWeight: '600',
  },
  // Roughly the width of the header actions, so the identity block stays
  // centred against the Back button on threads without them.
  actionSpacer: { width: 72 },
  list: { flex: 1 },
  messagesContent: { padding: spacing.md, flexGrow: 1 },
  spinner: { marginTop: spacing.xl },
  emptyThread: {
    marginTop: spacing.xl,
    textAlign: 'center',
    fontSize: fontSize.sm,
    color: colors.inkFaint,
  },
  composerBar: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingHorizontal: spacing.sm + 2,
    paddingTop: spacing.sm + 2,
    // paddingBottom is applied inline: COMPOSER_PAD + the home-indicator inset.
  },
  // A tinted strip above the input, so edit mode is unmistakable even at a
  // glance — the accent wash marks it as a state, not another message.
  editingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.accentTint,
  },
  editingText: { flex: 1 },
  editingLabel: {
    fontSize: fontSize.sm - 1,
    fontWeight: '700',
    color: colors.accentDeep,
  },
  editingOriginal: { fontSize: fontSize.sm, color: colors.inkSoft },
  editingCancel: {
    fontSize: fontSize.base,
    color: colors.inkSoft,
    paddingHorizontal: spacing.xs,
  },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  input: {
    flex: 1,
    maxHeight: 120,
    minHeight: 40,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.lg,
    backgroundColor: colors.raised,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    fontSize: fontSize.base,
    color: colors.ink,
  },
  send: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  sendDisabled: { opacity: 0.4 },
  sendLabel: { fontSize: fontSize.sm, fontWeight: '600', color: '#ffffff' },
  readonly: {
    textAlign: 'center',
    fontSize: fontSize.sm,
    color: colors.inkFaint,
    lineHeight: 19,
    paddingVertical: spacing.xs,
  },
  sendError: { marginTop: spacing.xs, fontSize: fontSize.sm, color: colors.danger },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.md,
  },
  emptyTitle: {
    fontSize: fontSize.base,
    fontWeight: '600',
    color: colors.ink,
    textAlign: 'center',
  },
  retry: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  retryText: { color: colors.ink, fontWeight: '600' },
  pressed: { opacity: 0.7 },
});
