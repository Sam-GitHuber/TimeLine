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
 *   - **swipe a bubble right to reply**, which is why this screen alone has no
 *     interactive back gesture — see `components/SwipeToReply` and the note on
 *     the route in `app/_layout.tsx`;
 *   - **@mentions** in a group (Phase 9b M8): typing `@` offers the thread's
 *     active members, and the ids of whoever you picked ride along with the
 *     send — which is what lets a mention reach a muted thread;
 *   - **multi-select** (Phase 9b M8): Select in that menu turns the header into
 *     a count and the composer into Copy / Delete, so a burst of messages can
 *     be dealt with in one action rather than one long-press at a time;
 *   - carries a `⋯` through to the **info screen** (Phase 9b M6), which is
 *     where mute / add people / leave / rename now live — they used to be text
 *     buttons crowding this header;
 *   - a 1:1 header links to the other person's profile;
 *   - a **pending** viewer (added but not yet connected to the whole clique) sees
 *     the locked `PendingChatPanel` instead of the message list;
 *   - a viewer who can no longer send (disconnected) gets a read-only footer.
 *
 * **Thread mechanics (Phase 9b M5)** — the milestone with no new feature in it
 * and most of the reason the thread felt wrong:
 *
 *   - **It loads one page.** This screen used to walk `fetchNextPage` in an
 *     effect until every page was in memory, so opening a chat pulled its whole
 *     history. That wasn't an oversight so much as a consequence: the endpoint's
 *     default order is oldest-first, so the newest messages are on the *last*
 *     page. `?order=desc` inverts that, the list is an **inverted `FlatList`**,
 *     and older messages page in *upward* on scroll.
 *   - Which also deleted the `scrollToEnd`-on-content-change hack: an inverted
 *     list is pinned to the newest message by construction, including while the
 *     keyboard animates.
 *   - **Day separators, clock times and grouped runs** (`threadRows.ts`), an
 *     **unread divider** at where you stopped reading, and **jump-to-latest**
 *     with a count once you've scrolled away.
 *   - **Drafts survive leaving the screen** (`drafts.ts`), and a quote whose
 *     original hasn't paged in is **fetched** rather than written off as
 *     unavailable (`quotes.ts`) — see the note on `resolveQuote`.
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
import * as Haptics from 'expo-haptics';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
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
  serverMessage,
  WENT_WRONG,
} from '@/api';
import { useAuth } from '@/auth';
import { prepareChatPhoto } from '@/chatPhotos';
import { Avatar } from '@/components/Avatar';
import { AvatarStack } from '@/components/AvatarStack';
import {
  KeyboardAvoider,
  useKeyboardVisible,
} from '@/components/KeyboardAvoider';
import type { BubbleAnchor, MessageAction } from '@/components/MessageActionMenu';
import { MessageActionMenu } from '@/components/MessageActionMenu';
import { MessageBubble } from '@/components/MessageBubble';
import { MentionSuggestions } from '@/components/MentionSuggestions';
import { MessageThreadView, threadQueryKey } from '@/components/MessageThreadView';
import { PendingChatPanel } from '@/components/PendingChatPanel';
import { PhotoLightbox } from '@/components/PhotoLightbox';
import { DaySeparator, UnreadDivider } from '@/components/ThreadDivider';
import { ReactorsSheet, reactorsQueryKey } from '@/components/ReactorsSheet';
import { ReportModal } from '@/components/ReportModal';
import { getDraft, setDraft } from '@/drafts';
import { useMentions } from '@/mentions';
import type { Outgoing, OutgoingPhoto } from '@/outbox';
import { asMessage, newOutgoing, updateOutbox, useOutbox } from '@/outbox';
import { usePhotoPicker } from '@/photoSource';
import {
  dismissConversationNotifications,
  setOnScreenConversation,
} from '@/push';
import type { SendState } from '@/readReceipts';
import { readStateFor, receiptsVisible } from '@/readReceipts';
import {
  colors,
  emojiPickerTheme,
  fontSize,
  radius,
  spacing,
} from '@/theme';
import type { ThreadRow } from '@/threadRows';
import { firstUnreadId, toThreadRows } from '@/threadRows';
import type {
  Author,
  Message,
  MessageAttachment,
  Paginated,
  Reaction,
} from '@/types';
import { useAndroidBack } from '@/useAndroidBack';
import { useWriteHold, WriteHoldProvider } from '@/writeHold';
import { useDayBoundary } from '@/useDayBoundary';

// A render error on this screen stops here instead of blanking the whole app
// (#299). expo-router wraps a route in its `ErrorBoundary` export, and installs
// nothing by default — see `components/ErrorBoundary` for what that means.
export { ErrorBoundary } from '@/components/ErrorBoundary';

/** The composer bar's base vertical padding, before the home-indicator inset. */
const COMPOSER_PAD = spacing.sm + 2;

/**
 * How far up the thread counts as "scrolled away", for the jump-to-latest
 * control. A couple of bubbles' worth: far enough that a stray flick doesn't
 * flash a button, near enough that you never have a message off-screen below you
 * without being told.
 */
const JUMP_THRESHOLD = 200;

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
type SendVars = {
  value: string;
  replyToId?: number;
  tempId: number;
  /** A prepared photo to upload with it (M7); absent on a text-only send. */
  photo?: OutgoingPhoto;
  /** Who it names (M8), as user ids — see `mentions.ts`. */
  mentionIds?: number[];
};

/**
 * Is this message already in a cached list?
 *
 * Asked in two places for two reasons — before inserting, so a poll that landed
 * between the response and the write doesn't produce the message twice; and
 * after inserting, so `onSuccess` can tell whether the write actually landed
 * anywhere before it lets go of the outbox entry (#325).
 *
 * Indifferent to the page-param type, since it only ever reads results — which
 * is what lets the query's own `data` and a `setQueryData` return value, typed
 * differently, both be asked the same question.
 */
function hasMessage(
  data: InfiniteData<Paginated<Message>, unknown> | undefined,
  messageId: number
) {
  return !!data?.pages.some((page) => page.results.some((m) => m.id === messageId));
}

/**
 * Put an accepted message into a cached list, if it isn't there already.
 *
 * Bridges the gap between "the POST returned" and "the refetch has landed": for
 * that second or two the outbox entry is gone and the poll hasn't run, so
 * without this the bubble would blink out and back.
 *
 * `newestFirst` is which end "newest" is at, and the two callers genuinely
 * differ: the transcript reads `?order=desc` so it can page lazily (M5), while
 * the focused thread view reads a whole short strand in the endpoint's default
 * oldest-first order. Passing it beats inferring from the data, which would be
 * a guess that reads correctly right up until a one-message list.
 *
 * The guard matters — a poll can land *between* the response and this write, so
 * the message may already be present, and inserting blind would show it twice.
 *
 * **It can decline to write**, and the caller has to care. With no pages there
 * is no list to insert into, so the message goes nowhere — see `onSuccess`,
 * which asks afterwards rather than assuming (#325).
 */
function insertMessage(
  data: InfiniteData<Paginated<Message>, string> | undefined,
  message: Message,
  { newestFirst }: { newestFirst: boolean }
) {
  if (!data?.pages.length) return data;
  if (hasMessage(data, message.id)) return data;
  const target = newestFirst ? 0 : data.pages.length - 1;
  const pages = data.pages.map((page, index) =>
    index === target
      ? {
          ...page,
          results: newestFirst
            ? [message, ...page.results]
            : [...page.results, message],
        }
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
  onSelect,
}: {
  message: Message;
  mine: boolean;
  canSend: boolean;
  now: number;
  onReply: (message: Message) => void;
  onEdit: (message: Message) => void;
  onDelete: (messageId: number) => void;
  onReport: (messageId: number) => void;
  onSelect: (message: Message) => void;
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
    // The way into select mode (M8), which is where it belongs: this menu is
    // already the answer to "do something with this message", and the second
    // message you want is the one you long-press *after* deciding there's more
    // than one. Starting with the pressed message selected means the common
    // case — this one and the next two — is three taps rather than four.
    { label: 'Select', onPress: () => onSelect(message) },
  ];
  // Reply (M3). No longer the *only* route: a rightward swipe on the bubble
  // does the same thing, now that the screen's back gesture is out of its way
  // (see `SwipeToReply`). The menu keeps it because a gesture with no visible
  // control is undiscoverable and unreachable by VoiceOver — the swipe is the
  // shortcut, this is the affordance. Left out where the server would refuse
  // the send anyway, like the reaction row.
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
  // Drives the composer's bottom pad: the safe-area inset is dead space once the
  // keyboard has lifted the bar clear of it. See `useKeyboardVisible`.
  const keyboardVisible = useKeyboardVisible();
  /**
   * Seeded from the draft store (M5), so a half-written message survives leaving
   * the thread and coming back. It used to die with the screen, which made
   * "check what they said in the other chat" a way to silently lose your words.
   */
  const [text, setText] = useState(() => getDraft(id));
  const listRef = useRef<FlatList<ThreadRow>>(null);
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
  /**
   * A photo picked and prepared, waiting on the composer for you to hit Send
   * (M7). Held here and not in the outbox because it hasn't been sent yet —
   * the outbox is for messages that are *on their way*.
   *
   * `preparing` covers the second or two of resize-and-strip after a pick, which
   * is long enough on a big photo to look like nothing happened.
   */
  const [attachment, setAttachment] = useState<OutgoingPhoto | null>(null);
  const [preparing, setPreparing] = useState(false);
  const { pickPhotos, photoMenu } = usePhotoPicker();
  /** The photo open in the full-screen viewer, if any. */
  const [lightbox, setLightbox] = useState<MessageAttachment | null>(null);
  /**
   * Multi-select (M8): the ids ticked, or `null` when we're not selecting at
   * all.
   *
   * One piece of state for both questions — *are we in select mode* and *what's
   * ticked* — because an empty selection is a real state you can sit in (you
   * un-ticked the message you started from) and a separate boolean would be a
   * second thing to keep in step with it.
   */
  const [selected, setSelected] = useState<Set<number> | null>(null);
  const selecting = selected !== null;

  /**
   * A hold for writes made by a child that owns neither of this screen's ways
   * out — today just `PendingChatPanel`'s Connect (#259).
   */
  const hold = useWriteHold();

  const goBack = () => {
    // Leaving the conversation unmounts the composer, and with it the only
    // renderer of a refused edit (#257) or of a refused Connect on the pending
    // panel (#259). The header's Back renders unavailable too; this is the
    // backstop. iOS's swipe-back is already off on this screen (see
    // `app/_layout.tsx`), and Android's hardware back is held above.
    if (reportingWrite) return;
    if (router.canGoBack()) router.back();
    else router.replace('/messages');
  };

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

  /**
   * **The transcript we have beats an error about refreshing it.** `loadError`
   * used to be a bare `convoQuery.isError`, and that is true of a *failed
   * refetch* too: query-core's error action sets `status: 'error'` while keeping
   * the data the query already holds. `staleTime` is 0, `focusManager` is wired
   * to `AppState`, and the detail is re-polled every
   * `CONVERSATION_DETAIL_POLL_MS` — so backgrounding the app and coming back on
   * patchy signal reliably failed a refetch of a fully-loaded chat, and the
   * header, the transcript and the composer (with whatever was half-typed in it)
   * were replaced by an error card. Nothing had been lost server-side; the
   * screen simply stopped showing what it had.
   *
   * A **404** is the exception and still outranks the cached copy: the thread
   * being deleted or out of reach is a real answer about *now*, not a failure to
   * ask. Same rule as `post/[postId].tsx` and `CommentThread` (#307/#308).
   *
   * Declared up here, next to the data they read, rather than beside the JSX
   * that uses them — because the mark-read effect below has to ask the same
   * question, and asking it a second way is how the two answers drift apart
   * (#315).
   */
  const notAvailable =
    convoQuery.error instanceof ApiError && convoQuery.error.status === 404;
  const loadError = notAvailable || (convoQuery.isError && !detail);
  /** Is any of this conversation actually on screen? */
  const showingThread = !loadError && !!detail;

  const isGroup = detail?.kind === 'group';
  // A pending member can't read or send — the messages endpoint 403s — so the
  // thread is replaced by PendingChatPanel below rather than fetching a list it
  // can't have.
  const isPending = detail?.my_status === 'pending';
  const canSend = detail?.can_send ?? false;

  /**
   * The thread, **newest page first** and paged lazily (M5).
   *
   * This screen used to walk `fetchNextPage` in an effect until every page was
   * loaded, so opening a chat pulled its entire history — invisible at today's
   * volumes and worse every month. It wasn't laziness: the endpoint's default
   * order is oldest-first, which puts the newest messages on the *last* page, so
   * "show me the bottom of this chat" genuinely meant loading all of it.
   * `getMessages` now asks for `?order=desc`, which makes page one the screenful
   * you opened to and lets `onEndReached` (the *top* of an inverted list) page
   * backwards into history.
   */
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
  /** Older messages, on reaching the top. The end of an inverted list is the top. */
  const loadOlder = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const pages = messagesQuery.data;
  /**
   * **The transcript is a second query, and it fails separately** (#321). The
   * header, the participants and the mute state all come from `convoQuery`, so
   * they render perfectly while this one is errored — and *"No messages yet —
   * say hello."* then appeared in a thread with years of history, under the name
   * of the person whose messages had just gone missing. `messagesQuery.isError`
   * was read nowhere in this file; only `convoQuery`'s was. The same mistake the
   * web's `ConversationThreadView` had, fixed there in #319.
   *
   * `!pages` rather than a bare `isError`, the same way round as `loadError`
   * above: this query polls on `MESSAGE_POLL_MS` and pages backwards into
   * history, so a failed poll or a failed page of older messages must not take
   * the transcript off screen (#309/#311).
   */
  const messagesLoadFailed = messagesQuery.isError && !pages;
  /**
   * Is the **transcript** on screen — which is a different question from
   * `showingThread`, and the one the mark-read write below actually asks.
   *
   * `showingThread` answers for the conversation: its header, its participants,
   * its composer. All of those come from `convoQuery` and render perfectly while
   * `messagesQuery` is errored — so on a cold transcript failure the screen said
   * *"Couldn't load these messages"* and the effect beside it dismissed this
   * thread's notifications and marked it read anyway. The reader is told there's
   * nothing there **and** the only signal that would bring them back is gone,
   * which is #318's shape reached from #321's cause.
   *
   * **`!!pages`, not `!messagesLoadFailed`** — the wait counts, and that is the
   * whole difference between a guard and a fix. Gating on the failure alone
   * still fires on the first commit after the detail lands, while the transcript
   * request is in flight and neither errored nor loaded: the dismissal has
   * already happened by the time we find out it failed, which is precisely the
   * trap #318 describes. Waiting is also what the effect already does for the
   * detail (M5), and for the same reason.
   *
   * A *failed poll* still marks read, because `pages` survives it — the reader
   * is looking at the messages, and skipping the write would leave the badge
   * claiming mail they'd just read (#309).
   */
  const readingMessages = showingThread && !!pages;
  const loaded = useMemo(
    () => pages?.pages.flatMap((page) => page.results) ?? [],
    [pages]
  );
  const messageCount = loaded.length;

  /**
   * Is there a transcript to have written into — the exact inverse of the guard
   * `insertMessage` declines on, and so the exact condition that ends a `sent`
   * hold (#325).
   *
   * **Not "is that message in the loaded pages".** The transcript pages lazily
   * from the newest end, so a message can be in the server's history and not in
   * the window we hold: come back to a busy thread and page one is the newest
   * twenty, which need not include the one being held. Keyed on the id, the hold
   * would then never end — the bubble would sit at the bottom of the chat
   * wearing the device clock as though it were the newest thing said, and
   * duplicate the moment paging reached it. Keyed on a message that was
   * *deleted* in the meantime, it would never end at all.
   *
   * The entry is held because there was nowhere to put the message. Once there
   * is somewhere, the server's own history is on screen and is the better
   * account of it, whether or not this particular screenful shows it.
   */
  const transcriptCached = !!pages?.pages.length;

  /**
   * The outbox minus anything the transcript has taken over (#325).
   *
   * Only ever drops a `sent` entry. When the transcript loads, its own copy of
   * that message is in the history, and for one committed render both would be
   * on screen: the entry's bubble and the server's. Filtering here rather than
   * waiting for the effect below means the duplicate is never painted at all —
   * the effect runs after the commit, which is a frame too late to be invisible.
   *
   * Everything that renders the outbox reads *this*, not `outbox`, so the views
   * and the id lookup can't disagree about what's still outstanding.
   */
  const outstanding = useMemo(
    () => outbox.filter((entry) => !(entry.status === 'sent' && transcriptCached)),
    [outbox, transcriptCached]
  );

  /**
   * And then actually let go of it, so the store doesn't quietly accumulate
   * messages the server has confirmed. Separate from the filter above because
   * they answer different questions — that one is "what should be on screen
   * this render", this one is "what is the outbox still holding" — and the
   * store outlives the screen, so leaving them in it would leak into the next
   * visit to the thread.
   *
   * Guarded on there being something to drop: `updateOutbox` notifies its
   * subscribers on every call, and this effect re-runs on every four-second
   * poll.
   */
  useEffect(() => {
    if (!transcriptCached) return;
    if (outstanding.length === outbox.length) return;
    setOutbox((entries) => entries.filter((entry) => entry.status !== 'sent'));
  }, [transcriptCached, outstanding.length, outbox.length, setOutbox]);

  /** You, as a message sender — what an outbox entry is dressed in. */
  const meAsAuthor: Author = useMemo(
    () => ({
      id: me?.pk ?? -1,
      display_name: me?.display_name ?? '',
      avatar_thumb: me?.avatar_thumb ?? null,
    }),
    [me?.pk, me?.display_name, me?.avatar_thumb]
  );
  const outboxById = new Map(outstanding.map((entry) => [entry.tempId, entry]));

  /**
   * How many messages were waiting when you opened the thread (M5) — captured
   * **once**, because the mark-read effect below moves the marker a moment later
   * and the divider has to outlive that.
   *
   * Latched **during render**, which is React's own "adjust state when the props
   * change" pattern rather than a shortcut past an effect. Two reasons it has to
   * be here: the mark-read POST goes out in the effect below, so the count must
   * be taken before anything asynchronous can zero it (which is also why that
   * effect waits for the detail — if the write won the race there'd be nothing
   * left to capture); and a `setState` from an effect would land a render later,
   * so the divider would appear a beat after the messages it divides.
   *
   * Taken from `unread_count` rather than your own `last_read_at`, which the
   * payload withholds entirely when you've turned read receipts off — see
   * `firstUnreadId`.
   */
  const [unreadOnOpen, setUnreadOnOpen] = useState<number | null>(null);
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
   * down the list, so a live re-derivation slides the divider past the very
   * messages it was placed to mark. The count is what's captured on open; *this*
   * is what the divider is drawn from.
   *
   * Latched during render like the count above it, and state rather than a ref
   * for the same reason: this *is* render data — the row it produces is built in
   * the same pass — and a ref read during render is both the thing React's lint
   * rule forbids and a real hazard, since nothing would re-render when it
   * changed. Staying `null` is deliberate and stays live: it means the unread run
   * is longer than what has loaded, which resolves itself as pages come in.
   */
  const [unreadFrom, setUnreadFrom] = useState<number | null>(null);
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
   * What the list renders: everything not yet accepted by the server, then
   * everything that is (M4), shaped into rows with their day separators, unread
   * divider and run flags (M5).
   *
   * **Newest-first throughout**, which is what an inverted list wants — so the
   * unsent messages go at the *front*. Concatenating rather than merging by
   * timestamp is both correct and simpler: a message that hasn't been accepted
   * is by definition newer than every message that has.
   *
   * `today` is a dependency, not a value used directly: it changes at local
   * midnight, which is the one moment "Today" and "Yesterday" go stale with no
   * data having changed. Same idiom as the feed.
   */
  const today = useDayBoundary();
  const rows = useMemo(
    () =>
      toThreadRows({
        messages: [
          // Reversed on the way in: the outbox holds entries oldest-first, and
          // everything downstream of here is newest-first.
          ...outstanding.map((entry) => asMessage(entry, meAsAuthor)).reverse(),
          ...loaded,
        ],
        meId: me?.pk,
        unread,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see `today` above
    [loaded, outstanding, meAsAuthor, me?.pk, unread, today]
  );

  /**
   * Open the thread **at the unread divider**, not at the bottom (M5).
   *
   * This is what the divider is *for*. A marker you have to go and find is a
   * decoration; a thread that opens where you stopped reading is the thing that
   * makes coming back to twenty messages tractable, and it's why the divider is
   * accented while the day separators aren't.
   *
   * Once, on the first render that can place it — the `rows` array is rebuilt on
   * every four-second poll, and re-running this would yank the list back up
   * under someone who had scrolled away from it. After that the jump-to-latest
   * control (which the scroll itself brings up) is how you get to the bottom,
   * which is the right way round: the newest message is one tap away, and the
   * one you left off at is already on screen.
   *
   * `viewPosition: 1` is the *top* of the screen on an inverted list — the
   * divider goes up there with the unread messages filling in beneath it. When
   * there are only a couple the computed offset is past the end and the list
   * clamps it, so a barely-scrolled thread stays put rather than lurching.
   */
  const openedAtUnread = useRef(false);
  const unreadRowIndex = rows.findIndex((row) => row.kind === 'unread');
  useEffect(() => {
    if (openedAtUnread.current || unreadRowIndex < 0) return;
    openedAtUnread.current = true;
    listRef.current?.scrollToIndex({
      index: unreadRowIndex,
      viewPosition: 1,
      animated: false,
    });
  }, [unreadRowIndex]);

  /**
   * The list has no `getItemLayout` — bubbles are as tall as their words — so a
   * divider outside the cells laid out so far has no measured offset to scroll
   * to, and `scrollToIndex` hands the problem back here rather than guessing.
   *
   * Estimate, let that render the cells around it, then land exactly. Bounded,
   * because the retry can fail the same way: two goes gets there from any
   * realistic starting point, and giving up leaves the thread at the estimate —
   * a few bubbles out, never broken.
   */
  const scrollAttempts = useRef(0);
  const settleOnRow = useCallback(
    ({
      index,
      averageItemLength,
    }: {
      index: number;
      averageItemLength: number;
    }) => {
      listRef.current?.scrollToOffset({
        offset: index * averageItemLength,
        animated: false,
      });
      if (scrollAttempts.current >= 2) return;
      scrollAttempts.current += 1;
      requestAnimationFrame(() => {
        listRef.current?.scrollToIndex({
          index,
          viewPosition: 1,
          animated: false,
        });
      });
    },
    []
  );

  /**
   * Jump-to-latest (M5) — the floating control that appears once you've scrolled
   * up, carrying a count of what has arrived since.
   *
   * The count is what makes it worth having. A bare arrow is a scroll shortcut;
   * "3 new" is the thing that tells you to take it, and it's the only way to
   * know a conversation moved on while you were reading back through it —
   * because the one place a new message *doesn't* announce itself is the thread
   * you already have open.
   */
  /**
   * When you left the bottom, as the timestamp of the newest message you had in
   * front of you at the time — `null` while you're still down there.
   *
   * One piece of state doing both jobs: whether to show the control at all, and
   * what "new" is counted against. Two (a boolean and a marker) would be two
   * things that can disagree, and the marker has to be captured at exactly the
   * moment the boolean flips.
   */
  const [awayFrom, setAwayFrom] = useState<number | null>(null);
  const newestAt = loaded[0] ? Date.parse(loaded[0].created_at) : 0;
  const scrolledUp = awayFrom !== null;
  const missed =
    awayFrom === null
      ? 0
      : loaded.filter(
          (m) => m.sender.id !== me?.pk && Date.parse(m.created_at) > awayFrom
        ).length;

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      // The list is inverted, so `y` is the distance *from the newest message*
      // rather than from the top of the history.
      const away = event.nativeEvent.contentOffset.y > JUMP_THRESHOLD;
      // `current ?? newestAt` pins the marker on the way *out* and leaves it
      // alone thereafter, so messages arriving while you read back through the
      // thread keep adding to the count instead of resetting it. Setting the
      // same value over and over is free — React bails out of an identical
      // update, which is why this can run on every scroll frame.
      setAwayFrom((current) => (away ? (current ?? newestAt) : null));
    },
    [newestAt]
  );
  const jumpToLatest = useCallback(() => {
    // Offset 0 on an inverted list is the bottom, which is where "latest" is.
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, []);

  /**
   * Read receipts (M4) — the participants carry them, so the ticks come from
   * the *detail* query, not the message list.
   *
   * `showReceipts` being false means **you** turned them off, and the whole
   * column of ticks disappears rather than freezing on "sent": a permanent
   * single tick would read as "nobody is ever reading these", where showing
   * nothing says the true thing, which is that you asked out of this.
   */
  // Memoised, not a bare `?? []`: the detail payload is re-fetched every
  // `CONVERSATION_DETAIL_POLL_MS`, and a fresh empty array each time would
  // rebuild the mention map (and everything keyed off it) on every tick.
  const participants = useMemo(
    () => detail?.participants ?? [],
    [detail?.participants]
  );
  const showReceipts = receiptsVisible(participants);

  /**
   * Who can be named with `@`, and what their names are (M8).
   *
   * **Groups only.** In a 1:1 there is exactly one person it could mean, so a
   * picker would be ceremony around a word — and the server would accept it
   * either way, so this is a UI decision rather than a rule.
   *
   * `mentionNames` is separate and covers *everyone* including you: it's what
   * the bubbles highlight from, and a message naming you has to light up as
   * much as one naming anyone else. The mention ids on a message are bare (the
   * server sends no names — see `Message.mentions`), so this map is the only
   * thing that can turn them back into the `@Ada` in the text.
   */
  const mentionable = useMemo(
    () =>
      isGroup
        ? participants.filter((p) => p.status === 'active' && p.id !== me?.pk)
        : [],
    [isGroup, participants, me?.pk]
  );
  const mentionNames = useMemo(
    () => new Map(participants.map((p) => [p.id, p.display_name])),
    [participants]
  );

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
    // `sending` and `failed` report on the send itself, which is your own
    // business and nothing to do with who has read what — they show either way.
    // **`sent` is the tick the setting turns off**, though (#325), and it isn't
    // a passing clock: a held entry wears it until the transcript loads, which
    // may be the whole visit. That's the "permanent single tick" the note above
    // says reads as *nobody is ever reading these*, on the one bubble that has
    // one. With receipts off it draws like every other delivered message here,
    // which is the honest thing and the consistent one.
    if (pending) {
      if (pending.status !== 'sent') return pending.status;
      return showReceipts ? 'sent' : undefined;
    }
    if (!showReceipts) return undefined;
    return readStateFor(message, participants, me?.pk);
  }

  /**
   * Give up on a failed send. The only way outbox text *the server never took*
   * is thrown away — an accepted one leaves by the reaping effect above, which
   * is a different thing entirely: that message still exists, just elsewhere.
   *
   * Which is why it refuses a `sent` entry, exactly as `retryMessage` does. The
   * bubble already withholds Discard on one, but that is a decision made in two
   * other files (here for the transcript, `MessageThreadView` for the strand),
   * and what it costs if they ever drift is a bubble deleted out from under a
   * message the recipient can read — #325's symptom, by the other route.
   */
  function discardSend(message: Message) {
    const entry = outboxById.get(message.id);
    if (!entry || entry.status === 'sent') return;
    setOutbox((entries) => entries.filter((e) => e.tempId !== message.id));
  }

  /**
   * Send a failed message again, from either the transcript or a strand.
   *
   * Refuses a `sent` entry (#325) even though nothing offers Retry on one: the
   * bubble decides what to draw and this decides what to send, and the cost of
   * those two drifting apart is the same text delivered twice.
   */
  function retryMessage(message: Message) {
    const entry = outboxById.get(message.id);
    if (entry && entry.status !== 'sent') retrySend(entry);
  }

  /**
   * Mark read on open and as new messages land, clearing the tab badge and this
   * thread's pill.
   *
   * **It waits for the detail now** (M5), where it used to fire on mount. The
   * unread divider is drawn from `unread_count` on that payload, and this POST
   * is what zeroes it — so run before the detail lands and the two race, with
   * the divider missing whenever the write wins. Waiting also stops a `pending`
   * viewer marking a thread read they can't see a line of, which was harmless
   * but never intended.
   *
   * **`showingThread` is the whole guard now, and `convoQuery.isError` is gone
   * from it (#309).** The two used to mean the same thing here — an error meant
   * the screen was an error card with no transcript on it, so not marking read
   * was right. That stopped being true the moment a failed *refetch* started
   * keeping the thread on screen: the reader is looking at the messages, and
   * skipping the write left the lock-screen notification and the tab badge
   * claiming unread mail they'd just read, until the detail poll next succeeded.
   *
   * **`!!detail` on its own isn't the replacement (#315),** tempting as it looks
   * — and it was what shipped here in #311. A *404* on a refetch never clears
   * the cached detail either, so `detail` stays truthy while every render branch
   * has switched to "This conversation isn't available", and this went on firing
   * a doomed write, on the detail poll's schedule, for a conversation showing
   * nothing. `showingThread` is the one value both halves of the file read, so
   * they can't drift.
   *
   * **`readingMessages`, not `showingThread` (#321).** The two came apart the
   * moment the transcript got an error branch of its own: the conversation can
   * be fully on screen while its messages are not. See `readingMessages` above
   * — it waits for the transcript exactly as this used to wait for the detail.
   */
  useEffect(() => {
    if (isPending || !readingMessages) return;
    // Take back this thread's notifications from the phone's notification
    // centre (#178). Reading a thread in the app is the commonest way a
    // notification goes stale, and until this landed nothing ever removed one:
    // you could read everything and still find "New message from Ada" on the
    // lock screen. Deliberately *not* chained onto the POST below — whether the
    // server hears about it doesn't change the fact the user has read it, and
    // the shade is local. Re-runs with the effect, so a push that arrives while
    // this thread is open is mopped up on the next poll.
    void dismissConversationNotifications([id]);
    // The unread count has already been latched during render, above — this is
    // the write it has to survive.
    api
      .markConversationRead(id)
      .then(() => {
        queryClient.invalidateQueries({ queryKey: ['unreadMessages'] });
        queryClient.invalidateQueries({ queryKey: ['conversations'] });
      })
      // Swallowed on purpose, and it has to be caught now the error guard above
      // is gone: this fires while the connection is patchy, which is exactly
      // when it will reject. There is nothing to tell the reader — they have
      // read the messages either way, and the next open marks it again — but an
      // uncaught rejection is a redbox in development and a warning in
      // production, for a write whose failure is genuinely uninteresting.
      .catch(() => {});
    // A boolean rather than `detail`: the payload is re-fetched every
    // `CONVERSATION_DETAIL_POLL_MS`, so depending on the object itself would
    // turn this into a mark-read poll of its own. A boolean flips once.
  }, [id, messageCount, isPending, readingMessages, queryClient]);

  /**
   * Tell the notification handler this thread is the one on screen (#178), so a
   * message arriving for it banners without also being filed in the
   * notification centre for you to find later and re-read.
   *
   * On focus rather than mount: this screen stays mounted underneath its own
   * info screen, and a thread the user has navigated away from must stop
   * claiming its pushes.
   *
   * **`readingMessages` gates it too (#321)**, for the same reason the
   * mark-read effect above does — this is the other half of "the writes beside
   * the screen agree with it", and the easier one to miss because it destroys
   * nothing itself. Claiming the thread makes `configureNotificationHandler`
   * return `shouldShowList: false` for its pushes, so while the transcript is
   * an error card a message arriving for this chat banners once and is never
   * filed in the notification centre. The reader is looking at "Couldn't load
   * these messages" and the one thing that would bring them back is dropped on
   * the floor — #318's outcome again, by omission rather than by a write.
   */
  useFocusEffect(
    useCallback(() => {
      if (!readingMessages) return;
      setOnScreenConversation(id);
      return () => setOnScreenConversation(null);
    }, [id, readingMessages])
  );

  /**
   * Keep the draft store in step with the composer (M5).
   *
   * **Skipped while editing**, which is the one case that would otherwise write
   * the wrong thing: in edit mode the composer holds an existing *message*, not
   * a draft, so persisting it would mean leaving mid-edit and coming back to
   * someone's sent words sitting in your input. The pre-edit draft is already
   * stored, and `stashedDraft` puts it back on screen.
   */
  useEffect(() => {
    if (!editing) setDraft(id, text);
  }, [id, text, editing]);

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
    mutationFn: ({ value, replyToId, photo, mentionIds }: SendVars) =>
      api.sendMessage(id, value, replyToId, photo, mentionIds),
    onSuccess: (message, { tempId }) => {
      // Write the accepted message into the cache *before* dropping the outbox
      // entry, so the bubble is never absent for the frame between the two.
      // React batches both, but the ordering is what makes that true rather
      // than incidental.
      const transcript = queryClient.setQueryData<
        InfiniteData<Paginated<Message>, string>
      >(['messages', id], (cached) =>
        insertMessage(cached, message, { newestFirst: true })
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
          // Oldest-first: the strand reads the endpoint's default order, since
          // a strand is short enough to load whole and has no reason to page
          // backwards. Only the transcript needs `?order=desc`.
          (cached) => insertMessage(cached, message, { newestFirst: false })
        );
      }
      // **Only let go of the entry if the transcript actually took the message**
      // (#325). The comment above is true whenever there's a list to write into
      // and false when there isn't: on a cold transcript failure `['messages',
      // id]` has no pages, `insertMessage` writes nowhere, and dropping the
      // entry anyway took a bubble off the screen for a message the server had
      // just accepted — which reads as *your message was thrown away*, and
      // invites sending it again. It went, and the other person has it; only
      // this screen lost it.
      //
      // So the entry stays, as `sent`: an ordinary delivered bubble beside the
      // "couldn't load the rest of this conversation" note, with no Retry to
      // press (a retry here would be a genuine duplicate — there's no
      // idempotency key). It is let go of the moment there is a cached
      // transcript to let go of it *to* — see `transcriptCached` above.
      //
      // Asking `hasMessage` of what came back beats testing the return for
      // `undefined`: `setQueryData` returns nothing when the updater does, but
      // an updater can also hand back data it declined to change, and the
      // question that matters is only ever "is the message in there now".
      if (hasMessage(transcript, message.id)) {
        setOutbox((entries) => entries.filter((e) => e.tempId !== tempId));
      } else {
        setOutbox((entries) =>
          entries.map((e) =>
            e.tempId === tempId ? { ...e, status: 'sent' as const } : e
          )
        );
      }
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
    photo,
    mentionIds,
  }: {
    value: string;
    replyToId?: number;
    rootId?: number;
    photo?: OutgoingPhoto;
    mentionIds?: number[];
  }) {
    // A light tap on send (M5) — the same one the long-press uses. It's the
    // physical acknowledgement that the message left, which matters more here
    // than it looks: the bubble appears instantly either way, so without it
    // there's no moment where anything *happened*. Fire and forget; a phone
    // with no taptic engine simply resolves it.
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    const entry = newOutgoing({ text: value, replyToId, rootId, photo, mentionIds });
    setOutbox((entries) => [...entries, entry]);
    return sendMutation.mutateAsync({
      value,
      replyToId,
      tempId: entry.tempId,
      photo,
      mentionIds,
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
        // The prepared files are still in the cache directory, so a retry
        // re-uploads them rather than asking the person to pick the photo again
        // — which is the same promise the text half of the outbox makes.
        photo: entry.photo,
        // And the same for who it named: a retry that dropped the mentions
        // would quietly stop reaching the muted thread it was written for.
        mentionIds: entry.mentionIds,
      })
      .catch(() => {});
  }

  const deleteMutation = useMutation({
    mutationFn: (messageId: number) => api.deleteMessage(id, messageId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['messages', id] });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
    // #220 §2 — the one mutation on this screen without the `onError` its
    // siblings all have. You confirm "Delete message?", the request fails on a
    // dropped connection, and the bubble stays: indistinguishable from the tap
    // not registering, so the natural response is to delete it again, against a
    // server that may have succeeded the first time.
    onError: (error) =>
      Alert.alert('Couldn’t delete that message', serverMessage(error, WENT_WRONG)),
  });

  /**
   * Delete several at once (M8).
   *
   * Sequential rather than `Promise.all`: each one is a soft delete the server
   * settles independently, and firing five at a thread you're also polling is
   * a burst for no gain — nobody is waiting on the round trip, because the
   * bubbles are already gone from the selection. One invalidation at the end,
   * so the transcript redraws once rather than five times.
   */
  const deleteManyMutation = useMutation({
    mutationFn: async (messageIds: number[]) => {
      for (const messageId of messageIds) {
        await api.deleteMessage(id, messageId);
      }
    },
    onSettled: () => {
      // On settle, not on success: a partial failure still deleted some of
      // them, and leaving those on screen until the next poll would look like
      // the whole action failed.
      queryClient.invalidateQueries({ queryKey: ['messages', id] });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
    onError: () =>
      Alert.alert(
        'Couldn’t delete everything',
        'Some messages are still there. Try again.'
      ),
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
    /**
     * #261 — the *other* spelling of an unreported write, and the reason this
     * alert exists alongside the line under the composer rather than replacing
     * it.
     *
     * The line below is inside the `KeyboardAvoider`, and three screen-level
     * `Modal`s are siblings of it: the strand, the photo lightbox and the
     * reactors sheet. Each is opaque and each stays reachable while the PATCH
     * is out — `busy` greys the Save button and nothing else — so a 403 landing
     * while one is open paints into a subtree drawn *underneath* it. The strand
     * also sets `accessibilityViewIsModal`, which takes the composer out of the
     * accessibility tree, so VoiceOver/TalkBack announce nothing at all and
     * never replay it.
     *
     * An `Alert` isn't part of this screen's tree, so being covered can't
     * happen to it — the same reason the bulk delete and both photo paths use
     * one. The inline line stays because it's the better answer when nothing is
     * covering it: it persists in context beside the text you're still editing,
     * where a dismissed dialog is gone.
     */
    onError: (error) =>
      Alert.alert('Couldn’t save the edit', serverMessage(error, WENT_WRONG)),
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
      Alert.alert('Couldn’t react', serverMessage(error, WENT_WRONG)),
  });

  /**
   * What Android's back button means on this screen (#168).
   *
   * Back is how Android dismisses things, and this screen stacks three
   * dismissible states that aren't Modals. An unclaimed press falls through to
   * the navigator and leaves the thread entirely — and in the edit case it
   * takes typed text with it, because cancelling is the *only* path that puts
   * `stashedDraft` back in the composer. Back on a half-written message you'd
   * paused to fix a typo in would have lost it, two screens ago.
   *
   * One handler rather than one `useAndroidBack` per state, because the
   * priority is the interesting part and this is the only place it's written
   * down. React Native runs back handlers most-recently-registered-first, so
   * three separate calls would order themselves by the sequence you happened to
   * *open* things in — a photo staged before you hit Edit would claim the press
   * ahead of the edit. Topmost first, decided here.
   *
   * "Topmost" means *what you can actually see*, which is why **selection comes
   * first**. Select mode takes over the composer's slot entirely (see the bulk
   * bar below), so while it's on, the editing banner and the staged-photo
   * preview aren't on screen at all. Staging a photo and then long-pressing
   * → Select is an ordinary sequence, and closing the photo underneath would
   * look like a dead press that silently threw the photo away — you'd only find
   * out after leaving select mode. Edit before photo below it, for the same
   * reason read the other way round: an edit *hides* the staged preview (#164 —
   * a `PATCH` can't carry it, so showing it would promise otherwise), so back
   * ends the edit and brings the photo back into view rather than dismissing
   * something you can't see and can't tell went.
   *
   * `stopEditing` is a hoisted function declaration, which is what lets this sit
   * next to the state it reads rather than 800 lines further down.
   */
  /**
   * A write on this screen that a hasty exit would silence.
   *
   * Two of them, and they never coexist because the panel replaces the whole
   * transcript: the message **edit** (#257 — see `stopEditing`) and the pending
   * panel's **Connect** (#259), which declares itself into `hold`. Hoisted to a
   * single predicate so the four gates that read it — this back handler,
   * `goBack`, the header's Back and its dimming — can't drift apart.
   *
   * The bulk delete stays out: it reports through `Alert.alert`, which is a
   * native dialog and outlives the screen that fired it.
   *
   * ⚠️ **The edit stays in even though #261 gave it an `Alert` too**, and the
   * reason is not the obvious one. `reset()` and the mutation's `onError` come
   * apart: measured against this version of React Query, `stopEditing`'s
   * `editMutation.reset()` on a PATCH still in flight clears the observer's
   * error state — so the line below is destroyed, which is #257 — but the
   * `onError` **still fires**, so since #261 the refusal reaches you either way.
   *
   * What the hold buys is no longer *whether* you're told; it's having anything
   * to do about it. Leaving edit mode drops the composer back to your pre-edit
   * draft, so an alert saying the correction failed would arrive with the
   * correction already gone, and the header's Back pops the screen outright.
   * The condition here is "a write a hasty exit would leave you unable to act
   * on", not "a write with only one renderer".
   */
  const reportingWrite = editMutation.isPending || hold.held;

  const dismissible =
    selecting || Boolean(editing) || attachment !== null || reportingWrite;
  useAndroidBack(dismissible, () => {
    // A write whose refusal renders on this screen and nowhere else outranks
    // every dismissal below it: while one is out the press does nothing rather
    // than falling through to the navigator, which would take the screen and
    // the message with it (#257/#259).
    if (reportingWrite) return;
    if (selecting) setSelected(null);
    // Leaving edit mode is held by `reportingWrite` above, not here (#257):
    // `stopEditing` calls `editMutation.reset()`, which detaches the observer
    // from a PATCH still on its way back, and the error line below is the only
    // thing that would have spoken the 403.
    else if (editing) stopEditing();
    else if (attachment) setAttachment(null);
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
   * The `@` picker's state for this composer (M8) — what to suggest as you
   * type, and which ids to send with what you wrote.
   *
   * Shared with the strand's composer only in the sense that both use the same
   * hook; each keeps its own picks, because they're writing different messages.
   */
  const mentions = useMentions({ people: mentionable, text, setText });

  /**
   * Whether Send/Save does anything — read by both the button's `disabled` and
   * `handleSend`, so the two can't disagree about it.
   *
   * Sending needs text *or* a photo (M7): a photo with no caption is an ordinary
   * message. Not while one is still being prepared, or the tap would send an
   * empty message and drop the photo.
   *
   * `preparing` short-circuits *both* modes, which is stricter than an edit
   * strictly needs — a `PATCH` never carries the queued photo, so a pick still
   * resizing has nothing to do with it. Left as one gate rather than pushed into
   * the send branch: reaching it means starting a pick and then opening Edit
   * inside the second or so the resize takes (the attach button is gone once
   * you're editing), it clears itself, and the web's composer is the same
   * expression — a divergence here would be two rules to keep in step for an
   * edge that lasts a moment.
   *
   * ⚠️ **An edit and a send ask different questions**, and conflating them was a
   * real bug (#164, the same one #163 fixed on the web): a queued photo made
   * `!value` false, so clearing the field mid-edit fired a `PATCH` with empty
   * text where the guard should have done nothing. The server 400s that on a
   * text message ("A message can't be empty") — but it *allows* it on a photo
   * message, since editing a caption down to nothing is a legitimate thing to
   * do (`MessageSerializer.validate`'s `has_attachments`). That's the rule
   * mirrored here: an edit needs words unless the message it's editing carries a
   * photo of its own. The composer's queued attachment has nothing to do with
   * it — a `PATCH` can't carry one.
   */
  const editingHasPhoto = (editing?.attachments?.length ?? 0) > 0;
  const canSubmit = preparing
    ? false
    : editing
      ? (!!text.trim() || editingHasPhoto) && !busy
      : !!text.trim() || !!attachment;

  /**
   * Send a new message, or save the one being edited — the transcript's composer
   * does both. Replies are sent from inside the focused thread, not from here.
   */
  function handleSend() {
    const value = text.trim();
    // One question, asked in one place: see `canSubmit`, which knows that an
    // edit and a send don't have the same idea of "there's something to send".
    if (!canSubmit) return;
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
    // Which of the people you picked are still named in what you're sending —
    // reconciled against the words, so a mention you typed and then deleted
    // doesn't buzz anyone. See `mentionIdsIn`.
    const mentionIds = mentions.idsFor(value);
    setText('');
    setAttachment(null);
    mentions.reset();
    queueSend({
      value,
      photo: attachment ?? undefined,
      mentionIds,
    }).catch(() => {});
  }

  /**
   * Attach a photo (M7): take one, or pick one from the library.
   *
   * **The camera is offered first, not just the library.** Sending a picture of
   * what's in front of you is at least half of what a photo in a chat is for,
   * and bouncing someone out to the camera app and back is the kind of friction
   * that makes an app feel like a website with a wrapper. The prompt itself
   * lives in `photoSource.tsx` so every screen that takes a photo asks the same
   * way — see there for why it's the shared action menu and not an `Alert`.
   *
   * The pick is full quality: every photo is resized and re-encoded a moment
   * later by `prepareChatPhoto`, and compressing twice would only throw away
   * detail before the step that decides how much to keep.
   */
  async function attachPhoto() {
    const assets = await pickPhotos('Send a photo');
    if (!assets) return;
    const asset = assets[0];

    setPreparing(true);
    try {
      // 🔒 This is where the photo is downscaled and its EXIF — including the
      // GPS coordinates a phone stamps on every shot — is stripped, by being
      // re-encoded from raw pixels. The server does none of that for chat
      // photos, on purpose (see `chatPhotos.ts`), so skipping this step would
      // send everyone in the thread the location the picture was taken.
      const prepared = await prepareChatPhoto(
        asset.uri,
        asset.width,
        asset.height
      );
      setAttachment(prepared);
    } catch {
      Alert.alert(
        'Couldn’t use that photo',
        'Something went wrong preparing it. Try another one.'
      );
    } finally {
      setPreparing(false);
    }
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

  /**
   * Leave edit mode, putting the pre-edit draft back in the composer.
   *
   * Three callers: the ✕, Android back, and `editMutation`'s own success.
   *
   * The `reset()` is only ever wanted for a **settled** failure — an error left
   * over from a finished edit shouldn't hang over a composer that isn't editing
   * anything. But `reset()` doesn't distinguish that from an edit still in
   * flight: in React Query v5 it detaches the observer from the running
   * mutation, so the PATCH's answer arrives with nothing left to paint the error
   * line (#257). The two hand routes in therefore hold while the write is out,
   * which is what makes this call safe rather than conditional.
   *
   * It can't take a blanket `if (!isPending)` guard instead: React Query runs
   * `onSuccess` *before* the mutation leaves its pending state, so one would
   * refuse the one call that has to work.
   */
  function stopEditing() {
    setEditing(null);
    setText(stashedDraft);
    setStashedDraft('');
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

  /**
   * Enter select mode with the long-pressed message already ticked (M8).
   *
   * Deleting a burst one long-press at a time is the irritation this exists to
   * remove, and a burst is exactly where you know you want the *next* few too —
   * so the message you pressed comes with you rather than making you tap it
   * again in a mode you just entered.
   */
  function startSelecting(message: Message) {
    setSelected(new Set([message.id]));
  }

  function toggleSelected(messageId: number) {
    setSelected((current) => {
      const next = new Set(current ?? []);
      if (!next.delete(messageId)) next.add(messageId);
      return next;
    });
  }

  /**
   * The selected messages, oldest-first — the order they were said in, which is
   * the only order a copied transcript reads correctly in.
   *
   * `loaded` is newest-first (the transcript reads `?order=desc`), so this
   * reverses rather than sorting: the list is already in order, just backwards.
   *
   * Memoised because `deletableSelection` below reads it during render, and
   * `loaded` is every message paged in so far — walking all of it on each
   * render while someone taps their way through a selection is work for
   * nothing. Empty outside select mode, so it costs nothing there either.
   */
  const selectedMessages = useMemo(
    () =>
      selected
        ? [...loaded].reverse().filter((m) => selected.has(m.id))
        : [],
    [loaded, selected]
  );

  /**
   * Copy the lot as text.
   *
   * A group prefixes each line with who said it, because a copied exchange
   * between three people is unreadable otherwise; a 1:1 doesn't, since pasting
   * "Me Myself: yes" into a note about a conversation you were in adds nothing.
   * Messages with no words (a photo on its own) are skipped rather than
   * rendered as a placeholder — the pasteboard takes text, and "📷 Photo" is
   * not something anyone wants in their notes.
   */
  function copySelected() {
    const lines = selectedMessages
      .filter((m) => m.text && !m.is_deleted)
      .map((m) =>
        isGroup ? `${m.sender.display_name}: ${m.text}` : m.text
      );
    if (lines.length > 0) {
      Clipboard.setStringAsync(lines.join('\n')).catch(() => {});
    }
    setSelected(null);
  }

  function confirmDeleteSelected() {
    const ids = selectedMessages.map((m) => m.id);
    Alert.alert(
      ids.length === 1 ? 'Delete message?' : `Delete ${ids.length} messages?`,
      'This can’t be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            deleteManyMutation.mutate(ids);
            setSelected(null);
          },
        },
      ]
    );
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

  const other = detail?.other;

  /** Whether every ticked message is one you could delete — Delete is offered
   * only then. A bulk action that silently did *part* of what it says (yours,
   * quietly skipping theirs) is worse than one that isn't offered. */
  const deletableSelection =
    selected !== null &&
    selected.size > 0 &&
    selectedMessages.every((m) => m.sender.id === me?.pk && !m.is_deleted);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Select mode takes over the header (M8): the identity of who you're
          talking to is not what you need while picking messages, and a count
          plus a way out is. The transcript below stays exactly where it was. */}
      {selecting ? (
        <View style={styles.topBar}>
          <Pressable
            onPress={() => setSelected(null)}
            accessibilityRole="button"
            accessibilityLabel="Cancel selection"
            hitSlop={8}
          >
            <Text style={styles.back}>Cancel</Text>
          </Pressable>
          <View style={styles.identity}>
            <Text style={styles.headerName}>
              {selected.size} selected
            </Text>
          </View>
          <View style={styles.actionSpacer} />
        </View>
      ) : (
      <View style={styles.topBar}>
        <Pressable
          onPress={goBack}
          disabled={reportingWrite}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={8}
        >
          <Text style={[styles.back, reportingWrite && styles.backDisabled]}>
            ← Back
          </Text>
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

        {/* One control, not three (M6). Mute, Add and Leave used to sit here as
            text buttons competing with the name of the person you're talking
            to — which is the one thing a chat header is for. They live on the
            info screen now, where they have room to say what they do; this is
            the door to it, and the muted state still shows here because a
            silenced chat has to say so somewhere you'll see it. */}
        {showingThread && !isPending ? (
          <Pressable
            onPress={() => router.push(`/messages/${id}/info`)}
            accessibilityRole="button"
            accessibilityLabel="Conversation details"
            hitSlop={8}
            style={styles.headerActions}
          >
            {detail.muted ? <Text style={styles.headerActionOn}>Muted</Text> : null}
            <Text style={styles.headerAction}>⋯</Text>
          </Pressable>
        ) : (
          // A fixed-width spacer keeps the identity block centred against the
          // Back button whether or not header actions are present.
          <View style={styles.actionSpacer} />
        )}
      </View>
      )}

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
        <WriteHoldProvider hold={hold}>
          <PendingChatPanel
            mustConnectWith={detail.must_connect_with}
            conversationId={id}
            onLeave={goBack}
          />
        </WriteHoldProvider>
      ) : (
        <KeyboardAvoider style={styles.fill} enabled={thread === null}>
          {/* `enabled` is off while the focused thread is open. The thread is a
              screen-level sibling with its own avoider, so both would otherwise
              respond to the same keyboard — and because the thread is transparent
              over a blurred copy of this transcript, the background one animating
              its padding makes the blurred transcript lurch as the keyboard
              opens. The inverted FlatList's viewport shrinking underneath can
              also leave the thread parked where the user never scrolled. */}
          {/* The list and its floating control share a box, so the jump button
              can sit at the bottom of the *transcript* rather than being laid
              out between it and the composer — where it would push the thread
              up and down as it appeared and vanished. */}
          <View style={styles.fill}>
            <FlatList
              ref={listRef}
              // The one handle a test has on the transcript. Scrolling is what
              // drives both the upward paging and the jump-to-latest control, and
              // neither is reachable through an accessibility label.
              testID="transcript"
              data={rows}
              keyExtractor={(row) => row.key}
              /**
               * The shape of a chat (M5): newest at the bottom, history paging in
               * above. Inversion is what makes that a *list* behaviour rather than
               * a pile of workarounds — it replaced a `scrollToEnd` on every
               * content-size change, and it means the newest message stays pinned
               * while the keyboard animates instead of being chased back into
               * view afterwards.
               *
               * Off when there's nothing to show, because an inverted list flips
               * its `ListEmptyComponent` too and "say hello" upside down is a
               * memorable bug to ship.
               */
              inverted={rows.length > 0}
              // `flex: 1` constrains the list to the gap between the header and the
              // composer. Without it a FlatList sizes to its content, so the newest
              // messages run *under* the composer.
              style={styles.list}
              contentContainerStyle={styles.messagesContent}
              // The "end" of an inverted list is the top of the history.
              onEndReached={loadOlder}
              onEndReachedThreshold={0.5}
              onScroll={handleScroll}
              scrollEventThrottle={16}
              // How the open-at-the-unread-divider scroll finds a row it hasn't
              // measured yet. See `settleOnRow`.
              onScrollToIndexFailed={settleOnRow}
              // Drag the keyboard away rather than having to tap elsewhere first,
              // and let a tap on a bubble or a link through while it's up.
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
              // Renders at the *top* on an inverted list — which is where the
              // older messages being fetched are about to appear, and where a
              // note about the history that *didn't* belongs.
              ListFooterComponent={
                isFetchingNextPage ? (
                  <ActivityIndicator color={colors.accent} style={styles.spinner} />
                ) : messagesLoadFailed && rows.length > 0 ? (
                  // **`ListEmptyComponent` can't answer for this one.** An
                  // unsent message in the outbox survives the screen, so a cold
                  // transcript failure with one queued leaves `rows` non-empty
                  // — the empty slot never gets its turn, and the card below
                  // (with the only retry) never renders. What's on screen is
                  // then a chat holding one bubble, years of history missing,
                  // and nothing saying why: the same claim by omission this
                  // whole change exists to remove. The line goes *beside* the
                  // bubble rather than over it, because replacing an unsent
                  // message with an apology reads as it having been thrown
                  // away. Same shape as the group timeline's and the profile's
                  // partial notes (#320).
                  <View style={styles.partial}>
                    <Text style={styles.inlineError}>
                      Couldn’t load the rest of this conversation.
                    </Text>
                    <Pressable
                      onPress={() => messagesQuery.refetch()}
                      accessibilityRole="button"
                      accessibilityLabel="Try loading the messages again"
                      hitSlop={8}
                      style={({ pressed }) => [styles.inlineRetry, pressed && styles.pressed]}
                    >
                      <Text style={styles.inlineRetryText}>Try again</Text>
                    </Pressable>
                  </View>
                ) : null
              }
              renderItem={({ item }) => {
                if (item.kind === 'day') return <DaySeparator label={item.label} />;
                if (item.kind === 'unread') {
                  return <UnreadDivider count={item.count} />;
                }
                const message = item.message;
                const mine = message.sender.id === me?.pk;
                const pending = outboxById.get(message.id);
                return (
                  <MessageBubble
                    message={message}
                    mine={mine}
                    // Only the run's first bubble is attributed (group threads
                    // only). A deleted message still starts a run, so its
                    // tombstone stays attributed.
                    showSender={isGroup && !mine && item.startsRun}
                    endsRun={item.endsRun}
                    status={statusFor(message)}
                    mentionNames={mentionNames}
                    // Select mode is the one time a tap on a bubble does
                    // something (M8) — and it doesn't break the "one gesture
                    // per target" rule so much as suspend it: while selecting,
                    // a tap means exactly one thing everywhere on the screen.
                    // An unsent message stays untappable: every bulk action
                    // needs a server id it hasn't got.
                    selected={selected?.has(message.id)}
                    onPress={
                      selecting && !pending
                        ? () => toggleSelected(message.id)
                        : undefined
                    }
                    // No viewer for an in-flight photo: the only copy is the
                    // local thumbnail standing in for it, so "open full size"
                    // has nothing to open until the upload lands.
                    onPhotoPress={pending ? undefined : setLightbox}
                    // Retry and Discard belong to a message the server hasn't
                    // taken. A `sent` entry is one it *has* (#325), waiting only
                    // for a transcript to appear in — so it gets neither: Retry
                    // would send the text a second time, and Discard would hide
                    // a message the other person can already read.
                    onRetry={
                      pending && pending.status !== 'sent'
                        ? () => retryMessage(message)
                        : undefined
                    }
                    onDiscard={
                      pending && pending.status !== 'sent'
                        ? () => discardSend(message)
                        : undefined
                    }
                    onShowReactors={() => setReactorsFor(message.id)}
                    // Browsing into the strand rather than replying to a
                    // particular message, so the composer aims at the root. The
                    // thread's *root*, not the bubble you tapped: a root opens its
                    // own strand, a reply opens the one it belongs to. The server
                    // owns the flattening, so this is a read of it, never a second
                    // copy of the rule.
                    //
                    // **Withheld while selecting**, which is what makes "select
                    // mode wins the tap" true rather than nearly true. A bubble
                    // decides it opens a strand from `onOpenThread` being present
                    // and `onPress` being absent — and `onPress` is absent on an
                    // *unsent* message even mid-selection, since it has no server
                    // id to tick. Without this the one bubble in a selection you
                    // can't tick would be the one that opens a Modal over it.
                    // Drops the "N replies" branch too, exactly as the web drops
                    // its strand links while selecting.
                    onOpenThread={
                      selecting
                        ? undefined
                        : () => {
                            const rootId = message.thread_root_id ?? message.id;
                            setThread({
                              rootId,
                              replyToId: rootId,
                              composing: false,
                            });
                          }
                    }
                    // **Swipe right to reply** — the same destination as the
                    // menu's Reply, on the gesture people arrive expecting.
                    // Gated exactly where Reply is gated, plus two the menu
                    // never has to think about: a tombstone has nothing to
                    // answer, and while selecting, a drag across the list is
                    // how you scroll a selection you're building. See
                    // `SwipeToReply` for why the screen's back gesture had to
                    // go first.
                    onSwipeReply={
                      canSend && !pending && !selecting && !message.is_deleted
                        ? () => startReplying(message)
                        : undefined
                    }
                    // No menu on an unsent message: every action it offers —
                    // edit, delete, react, report — needs a server id this one
                    // hasn't got. Retry and Discard are on the bubble instead.
                    onLongPress={
                      pending || selecting
                        ? undefined
                        : (anchor) =>
                            setMenuTarget({
                              message,
                              mine,
                              anchor,
                              actions: messageActions({
                                message,
                                mine,
                                canSend,
                                now: Date.now(),
                                onReply: startReplying,
                                onEdit: startEditing,
                                onDelete: confirmDelete,
                                onReport: setReportingId,
                                onSelect: startSelecting,
                              }),
                            })
                    }
                  />
                );
              }}
              /* Reached only when `rows` is empty, which is the right gate
                 rather than `loaded`: an unsent message waiting in the outbox is
                 still something on screen, and replacing it with an apology
                 would look like it had been thrown away. */
              ListEmptyComponent={
                messagesLoadFailed ? (
                  <View style={styles.centre}>
                    <Text style={styles.emptyTitle}>Couldn’t load these messages</Text>
                    <Text style={styles.emptyBody}>
                      {serverMessage(messagesQuery.error, WENT_WRONG)}
                    </Text>
                    <Pressable
                      onPress={() => messagesQuery.refetch()}
                      accessibilityRole="button"
                      accessibilityLabel="Try loading the messages again"
                      style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
                    >
                      <Text style={styles.retryText}>Try again</Text>
                    </Pressable>
                  </View>
                ) : !pages ? (
                  // `!pages`, not `isLoading`. This query is `enabled` only once
                  // the detail has landed, and a *disabled* query is neither
                  // loading nor errored — so on a cold open the empty state used
                  // to paint "No messages yet" in the gap before the transcript
                  // was even asked for. (It would cover the paused state too, if
                  // `onlineManager` were ever wired — see `mobile-app.md`.)
                  <ActivityIndicator color={colors.accent} style={styles.spinner} />
                ) : (
                  <Text style={styles.emptyThread}>No messages yet — say hello.</Text>
                )
              }
            />

            {/* Floating over the list, just above the composer. Only while you're
                actually away from the bottom — a control that's always there is
                one nobody reads. */}
            {scrolledUp ? (
              <Pressable
                onPress={jumpToLatest}
                accessibilityRole="button"
                accessibilityLabel={
                  missed > 0
                    ? `Jump to latest, ${missed} new ${
                        missed === 1 ? 'message' : 'messages'
                      }`
                    : 'Jump to latest'
                }
                style={({ pressed }) => [styles.jump, pressed && styles.pressed]}
              >
                <Text style={styles.jumpArrow}>↓</Text>
                {missed > 0 ? (
                  <Text style={styles.jumpCount}>{missed} new</Text>
                ) : null}
              </Pressable>
            ) : null}
          </View>

          {/* Pad the bar past the home-indicator inset so the composer and Send
              button clear the bottom edge / swipe area on full-screen phones. On
              a home-button phone `insets.bottom` is 0, so this is the base pad.
              Dropped while the keyboard is up: `KeyboardAvoider` has already
              lifted the bar clear, so the inset would be dead space between the
              composer and the keys — ~34pt on iOS, and up to ~48dp on Android
              three-button navigation, because the library pads by the full IME
              inset measured from the window bottom. */}
          <View
            style={[
              styles.composerBar,
              {
                paddingBottom:
                  COMPOSER_PAD + (keyboardVisible ? 0 : insets.bottom),
              },
            ]}
          >
            {/* While selecting, the composer's slot holds the bulk actions
                instead (M8). Same place, so your thumb doesn't move, and there
                is never both a composer and an action bar competing for the
                bottom of the screen. */}
            {selecting ? (
              <View style={styles.bulkBar}>
                <Pressable
                  onPress={copySelected}
                  disabled={selected.size === 0}
                  accessibilityRole="button"
                  accessibilityLabel="Copy selected messages"
                  style={({ pressed }) => [pressed && styles.pressed]}
                >
                  <Text
                    style={[
                      styles.bulkAction,
                      selected.size === 0 && styles.bulkDisabled,
                    ]}
                  >
                    Copy
                  </Text>
                </Pressable>
                {/* Only when every ticked message is one you can delete — see
                    `deletableSelection`. Absent rather than disabled: a
                    permanently greyed Delete beside someone else's message
                    reads as a bug, where nothing at all reads as "not yours". */}
                {deletableSelection ? (
                  <Pressable
                    onPress={confirmDeleteSelected}
                    accessibilityRole="button"
                    accessibilityLabel="Delete selected messages"
                    style={({ pressed }) => [pressed && styles.pressed]}
                  >
                    <Text style={[styles.bulkAction, styles.bulkDestructive]}>
                      Delete
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ) : canSend ? (
              <>
                {/* Edit mode says plainly what's being changed and offers an
                    obvious way out. Cancelling restores the draft you were
                    typing — and emptying the composer just disables Save, except
                    on a message carrying its own photo, where clearing the
                    caption is a legitimate edit that still leaves the picture
                    (see `canSubmit`). Either way there's no path from "editing"
                    to an accidental delete. */}
                {editing ? (
                  <View style={styles.editingBar}>
                    <View style={styles.editingText}>
                      <Text style={styles.editingLabel}>Editing message</Text>
                      <Text style={styles.editingOriginal} numberOfLines={1}>
                        {editing.text}
                      </Text>
                    </View>
                    {/* Held while the PATCH is out (#257) — same reason as the
                        back handler, and shown as unavailable rather than
                        silently declining, because a ✕ that answers a press
                        with nothing reads as broken. */}
                    <Pressable
                      onPress={stopEditing}
                      disabled={busy}
                      accessibilityRole="button"
                      accessibilityLabel="Cancel editing"
                      hitSlop={8}
                    >
                      <Text
                        style={[
                          styles.editingCancel,
                          busy && styles.editingCancelDisabled,
                        ]}
                      >
                        ✕
                      </Text>
                    </Pressable>
                  </View>
                ) : null}

                {/* The photo waiting to be sent (M7), above the input — where
                    you can see it while writing the caption, and where the ✕ to
                    change your mind is nowhere near Send. Only one at a time:
                    picking several photos sends several messages, so each gets
                    its own bubble and its own reactions and replies.

                    Hidden while editing rather than dropped (#164): an edit is a
                    `PATCH` of *text*, so it can't carry an attachment, and
                    leaving the picture sitting over the composer would say it
                    was going with the edit. Throwing it away because someone
                    stopped to fix a typo would be the same small betrayal
                    `stashedDraft` exists to prevent, so it comes back with the
                    draft when the edit ends. */}
                {!editing && (attachment || preparing) ? (
                  <View style={styles.attachment}>
                    {preparing ? (
                      <View style={styles.attachmentPreparing}>
                        <ActivityIndicator color={colors.accent} />
                      </View>
                    ) : attachment ? (
                      <>
                        {/* A local file, not our media host — a plain Image is
                            right; AuthedImage would attach a pointless header. */}
                        <Image
                          source={{ uri: attachment.previewUri }}
                          style={styles.attachmentThumb}
                        />
                        <Pressable
                          onPress={() => setAttachment(null)}
                          hitSlop={8}
                          accessibilityRole="button"
                          accessibilityLabel="Remove photo"
                          style={styles.attachmentRemove}
                        >
                          <Text style={styles.attachmentRemoveText}>✕</Text>
                        </Pressable>
                      </>
                    ) : null}
                  </View>
                ) : null}

                {/* Who you might be naming (M8), above the input and below
                    everything else in the bar — nearest the words being typed,
                    and out of the way the moment there's no `@` in progress.

                    Not offered while editing, for the same reason the attach
                    button isn't: an edit carries no `mention_ids`, so picking
                    someone here would do nothing at all — no notification, and
                    not even a highlight, since the highlight is driven by the
                    ids rather than by the words. A picker that silently does
                    nothing is worse than no picker. Adding a mention means
                    sending a message. */}
                {editing ? null : (
                  <MentionSuggestions
                    people={mentions.suggestions}
                    onChoose={mentions.choose}
                  />
                )}

                <View style={styles.composer}>
                  {/* No attach button while editing: an edit changes the words
                      of a message someone may already have read, and swapping
                      its photo is not something the "Edited" marker can honestly
                      disclose. The server refuses it too. */}
                  {editing ? null : (
                    <Pressable
                      onPress={attachPhoto}
                      disabled={preparing}
                      accessibilityRole="button"
                      accessibilityLabel="Add a photo"
                      hitSlop={6}
                      style={({ pressed }) => [
                        styles.attach,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Text style={styles.attachIcon}>＋</Text>
                    </Pressable>
                  )}
                  <TextInput
                    ref={inputRef}
                    value={text}
                    onChangeText={mentions.onChangeText}
                    // Where the caret is, which is what decides whether you're
                    // half-way through typing an `@name` *right now* (M8).
                    onSelectionChange={(event) =>
                      mentions.onSelectionChange(
                        event.nativeEvent.selection.start
                      )
                    }
                    placeholder="Write a message…"
                    placeholderTextColor={colors.inkFaint}
                    multiline
                    style={styles.input}
                    accessibilityLabel="Message"
                  />
                  <Pressable
                    onPress={handleSend}
                    disabled={!canSubmit}
                    accessibilityRole="button"
                    accessibilityLabel={editing ? 'Save' : 'Send'}
                    style={({ pressed }) => [
                      styles.send,
                      !canSubmit && styles.sendDisabled,
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
                {serverMessage(editMutation.error, "Couldn't save the edit. Try again.")}
              </Text>
            )}
          </View>
        </KeyboardAvoider>
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
          mentionable={mentionable}
          mentionNames={mentionNames}
          // The strand's own unsent replies, so a reply appears the moment you
          // send it and a failed one is recoverable *here* rather than only in
          // the transcript behind the blur.
          // A `sent` entry is left out (#325). It is held against the
          // *transcript's* cache, and the strand has one of its own: the send
          // writes into both, so a reply can land in the strand while the
          // transcript has no pages to take it — and then the strand would
          // render the server's copy and this one side by side, reading as
          // having sent the reply twice. The transcript behind the blur still
          // holds it, which is where the hold is for.
          outgoing={outstanding
            .filter((entry) => entry.status !== 'sent' && entry.rootId === thread.rootId)
            .map((entry) => asMessage(entry, meAsAuthor))}
          statusFor={statusFor}
          onRetry={retryMessage}
          onDiscard={discardSend}
          // Replies go through the same outbox as everything else (M4), so a
          // reply that fails is a failed bubble in the transcript with Retry on
          // it, rather than text that existed only inside a view you've since
          // closed. `mutateAsync` still, so the strand can keep what you wrote
          // if the send doesn't land while you're looking at it.
          onSend={(value, replyToId, mentionIds) =>
            queueSend({ value, replyToId, rootId: thread.rootId, mentionIds })
          }
          onClose={() => setThread(null)}
        />
      ) : null}

      {/* A photo, full screen (M7). The same viewer the feed uses, handed one
          photo: a chat's pictures aren't a gallery you swipe through from a
          bubble — the message is the unit, and the whole chat's photos have
          their own grid on the info screen. */}
      {lightbox ? (
        <PhotoLightbox
          images={[
            {
              id: lightbox.id,
              image: lightbox.url,
              thumbnail: lightbox.thumbnail,
              width: lightbox.width,
              height: lightbox.height,
            },
          ]}
          initialIndex={0}
          onClose={() => setLightbox(null)}
        />
      ) : null}

      {menuTarget ? (
        <MessageActionMenu
          message={menuTarget.message}
          mine={menuTarget.mine}
          anchor={menuTarget.anchor}
          actions={menuTarget.actions}
          mentionNames={mentionNames}
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

      {/* The camera/library sheet. `null` on iOS, where it's native. It's
          opened from the composer, never from inside the focused strand, so it
          can't end up as a modal stacked on a modal. */}
      {photoMenu}
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
  backDisabled: { opacity: 0.4 },
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
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.xs,
    minWidth: 24,
  },
  // The ⋯ itself: larger than body text, because it's a target as well as a
  // glyph and three dots at 14px are hard to hit and harder to see.
  headerAction: { fontSize: fontSize.lg, color: colors.accent, fontWeight: '700' },
  // The muted state riding beside it: dimmed rather than accented, because a
  // muted thread is the quiet state and shouldn't draw the eye.
  headerActionOn: {
    fontSize: fontSize.sm,
    color: colors.inkFaint,
    fontWeight: '600',
  },
  // The same width as the ⋯ control, so the identity block doesn't shift
  // sideways between a thread that has one and a loading/pending one that
  // doesn't.
  actionSpacer: { width: 24 },
  list: { flex: 1 },
  messagesContent: { padding: spacing.md, flexGrow: 1 },
  spinner: { marginTop: spacing.xl },
  // Floating over the transcript's bottom-right, clear of the composer.
  jump: {
    position: 'absolute',
    right: spacing.md,
    bottom: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.pill,
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    // A real shadow, because it's the one element genuinely floating above the
    // thread rather than sitting in it.
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  jumpArrow: { fontSize: fontSize.sm, color: colors.inkSoft, fontWeight: '700' },
  jumpCount: { fontSize: fontSize.sm - 1, fontWeight: '700', color: colors.accent },
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
  // The bulk action row (M8), in the composer's slot. Spaced apart rather than
  // side by side: Copy and Delete are a harmless action and an irreversible one,
  // and they should not be neighbours your thumb can confuse.
  bulkBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  bulkAction: {
    fontSize: fontSize.base,
    fontWeight: '600',
    color: colors.accent,
  },
  bulkDestructive: { color: colors.danger },
  bulkDisabled: { opacity: 0.4 },
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
  // Held while the edit's PATCH is out (#257), dimmed the same way Save beside
  // it already is.
  editingCancelDisabled: { opacity: 0.4 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  // Sized to match the input's collapsed height so the three controls sit on one
  // line rather than the ＋ floating above a grown, multi-line composer.
  attach: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The full-width form of "+" — a hairline glyph at this size reads as a
  // scratch on the screen rather than a button.
  attachIcon: { fontSize: fontSize.base, color: colors.inkSoft, lineHeight: 20 },
  attachment: { marginBottom: spacing.sm, alignSelf: 'flex-start' },
  attachmentThumb: { width: 72, height: 72, borderRadius: radius.md },
  attachmentPreparing: {
    width: 72,
    height: 72,
    borderRadius: radius.md,
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Overlapping the thumbnail's top-right corner, the way a removable chip is
  // dismissed everywhere else in the app (see the compose box's photo strip).
  attachmentRemove: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachmentRemoveText: {
    color: '#ffffff',
    fontSize: fontSize.sm - 2,
    lineHeight: 14,
  },
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
  emptyBody: { fontSize: fontSize.sm, color: colors.inkSoft, textAlign: 'center' },
  // The quieter shape: a line beside content that *did* render, rather than the
  // centred card a wholly-empty transcript gets. Its retry is **accent-coloured
  // text, not `retryText`** — that style is only legible as a button inside the
  // bordered `retry` pill, and bare it renders as bold body copy, which is a
  // retry nobody recognises as tappable.
  partial: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: 2 },
  inlineError: {
    fontSize: fontSize.sm,
    color: colors.danger,
    textAlign: 'center',
    lineHeight: 20,
  },
  inlineRetry: { alignSelf: 'center', paddingVertical: spacing.xs },
  inlineRetryText: { fontSize: fontSize.sm, color: colors.accent, fontWeight: '700' },
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
