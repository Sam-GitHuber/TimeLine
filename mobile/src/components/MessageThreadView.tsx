/**
 * The focused reply thread (Phase 9b M3).
 *
 * Blurs the transcript and brings a whole mini-conversation forward: the root at
 * the top, every reply under it, a composer pinned below that sends straight
 * back into the thread.
 *
 * **Every route to a reply comes through here**, whether you tapped "3 replies"
 * on a root, tapped a reply (its strand edge), or hit Reply on a message that has no
 * replies at all — the last of those opens a strand one bubble long, on purpose.
 * You reply *inside* the conversation you're joining, with the thing you're
 * answering on screen while you write it. The alternative (aim the transcript's
 * composer at a message, show a quote bar) was built first and replaced: it
 * shows you the one message you're answering and none of the exchange around it,
 * which is the same limitation that made the collapsed-quote design wrong.
 *
 * **Why this rather than a quote bar and nothing else.** The cheaper pattern —
 * each reply carrying a collapsed quote of the one message it answers — was the
 * original plan and was re-specified after trying it. With only quotes, a
 * back-and-forth inside a busy chat can never be *read* as a conversation; you
 * reconstruct it by scrolling and matching quotes by eye. Bringing the thread
 * forward means a side conversation stays legible without the main thread having
 * to reorder itself around it. The collapsed quote is gone entirely as of M9g; a
 * reply in the transcript wears a **strand edge**, and tapping it opens this.
 *
 * **The blur is doing real work, and isn't decoration.** A plain dim scrim reads
 * as "a modal over a list"; the blur reads as the same conversation pushed out of
 * focus, which is the whole point — you haven't gone anywhere, you've narrowed to
 * a strand of the thread you're already in.
 *
 * **Android has no blur to do that work, so the wash does it instead** (Phase
 * 10). `expo-blur` is iOS-first: on Android it paints a flat translucent tint
 * unless you both opt into `blurMethod` *and* give it a `<BlurTargetView>` in
 * the same window — and this is a `Modal`, which is a window of its own. The
 * near-solid `washAndroid` below is the honest version of the same intent; see
 * the note on it.
 *
 * **Deliberately no long-press menu in here.** Copy/Edit/Delete/Report and the
 * reaction row all live in `MessageActionMenu`, which is itself a `Modal` — and
 * presenting a modal from inside a presented modal is the iOS trap `ReactionTray`
 * and the emoji picker already document. Close the thread and act on the message
 * in the transcript, where the menu is one press away. That keeps this view what
 * it says it is: read the strand, add to it.
 *
 * **A missing root is a real state, not a loading one.** The thread is fetched
 * through the same interval-clipped endpoint as the transcript, so a member who
 * was out of the chat when the root was sent gets the replies they're entitled
 * to and no head. That says "The start of this thread isn't available to you"
 * rather than erroring, because nothing has gone wrong — see `messaging.md`.
 */

import { useInfiniteQuery } from '@tanstack/react-query';
import { BlurView } from 'expo-blur';
import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MentionSuggestions } from './MentionSuggestions';
import { MessageBubble } from './MessageBubble';
import { api, MESSAGE_POLL_MS } from '@/api';
import {
  KeyboardAvoider,
  useKeyboardVisible,
} from '@/components/KeyboardAvoider';
import { useFetchAllPages } from '@/lists';
import type { Mentionable } from '@/mentions';
import { useMentions } from '@/mentions';
import type { SendState } from '@/readReceipts';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { Message } from '@/types';

export function threadQueryKey(conversationId: number, rootId: number) {
  return ['thread', conversationId, rootId] as const;
}

export function MessageThreadView({
  conversationId,
  rootId,
  replyToId,
  composing = false,
  meId,
  isGroup,
  canSend,
  mentionable = [],
  mentionNames,
  outgoing,
  statusFor,
  onSend,
  onRetry,
  onDiscard,
  onClose,
}: {
  conversationId: number;
  /** The thread's root message id — what the transcript's branch links to. */
  rootId: number;
  /**
   * The message a reply will answer. Defaults to the root, which is right when
   * you got here by browsing; **Reply** passes the message you actually tapped,
   * so a reply to a reply names the person you meant above the composer rather
   * than whoever happened to start the strand.
   */
  replyToId?: number;
  /** Reply brought you here, so open with the keyboard already up. */
  composing?: boolean;
  meId?: number;
  isGroup: boolean;
  canSend: boolean;
  /**
   * Who can be named with `@` from in here (Phase 9b M8) — the same group
   * members the transcript offers. A reply is where you'd most often name
   * someone ("@Ada what do you think?"), so the strand gets the picker too
   * rather than being the one composer that quietly doesn't.
   */
  mentionable?: Mentionable[];
  /** Names for the mention ids on these messages; see `MessageBubble`. */
  mentionNames?: Map<number, string>;
  /**
   * Replies to this strand still in the caller's outbox (Phase 9b M4), already
   * dressed as messages. Rendered after the loaded ones, so a reply appears the
   * instant you send it and a failed one stays put with somewhere to act on it —
   * rather than only existing in the transcript behind the blur, where you
   * can't see it.
   */
  outgoing?: Message[];
  /** The tick/clock for a bubble. The caller owns it; see the thread screen. */
  statusFor?: (message: Message) => SendState | undefined;
  /**
   * Send into this thread. The caller owns the mutation (and so the outbox and
   * the cache invalidation), because a reply is an ordinary message and has to
   * land in the transcript as well as here.
   *
   * Resolves when the send lands and rejects when it doesn't; the composer
   * doesn't wait on either, since the message is already on screen.
   */
  onSend: (
    text: string,
    replyToId: number,
    mentionIds?: number[]
  ) => Promise<unknown>;
  onRetry?: (message: Message) => void;
  onDiscard?: (message: Message) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();
  const listRef = useRef<FlatList<Message>>(null);
  const [text, setText] = useState('');
  const mentions = useMentions({ people: mentionable, text, setText });

  /**
   * Polled like the transcript, so a reply someone else sends while you're
   * reading the strand appears in it rather than only behind the blur.
   *
   * **Paged, and every page pulled.** The thread endpoint is the ordinary
   * message list with a filter, so it paginates like every list — and a single
   * page is 20. Reading only the first would silently cut a strand off at its
   * *oldest* 20 messages (they come oldest-first), which hides the newest
   * replies and, worse, the one you just sent from the composer right there.
   * The root's "N replies" count would go on climbing past what the strand
   * showed, with nothing on screen to explain it.
   *
   * **The transcript no longer does this, and that's the difference between the
   * two views rather than an inconsistency** (Phase 9b M5). A transcript is
   * unbounded and grows forever, so it reads `?order=desc` and pages lazily
   * upward; a strand is one exchange inside it, bounded by how much anyone says
   * in reply to a single message. Loading a short list whole is right here and
   * was wrong there.
   *
   * "Every page" means every page that *loads*: a failed one stops the walk
   * rather than restarting it (`useFetchAllPages`, #248), which on this panel
   * would otherwise have run for the whole time the strand stayed open — it
   * polls, so the loop had no natural end. The cost is that the strand can sit
   * in the clipped state above until a poll gets through, which is why the
   * footer below says so rather than leaving the gap unexplained.
   */
  const threadQuery = useInfiniteQuery({
    queryKey: threadQueryKey(conversationId, rootId),
    queryFn: ({ pageParam }) =>
      pageParam
        ? api.getPage<Message>(pageParam)
        : api.getThread(conversationId, rootId),
    initialPageParam: '' as string,
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
    refetchInterval: MESSAGE_POLL_MS,
  });
  useFetchAllPages(threadQuery);

  const loaded = threadQuery.data?.pages.flatMap((page) => page.results) ?? [];
  // Unsent replies go last: one that hasn't been accepted is by definition
  // newer than every reply that has.
  const messages = [...loaded, ...(outgoing ?? [])];
  // Quotes resolve against *loaded* messages only — nothing can be quoting a
  // reply the server hasn't given an id to yet.
  const byId = new Map(loaded.map((m) => [m.id, m]));
  const root = byId.get(rootId);
  const target = replyToId ?? rootId;
  // Named only when it isn't the head of the strand — otherwise the label would
  // just restate the message sitting at the top of the screen.
  const answering = target === rootId ? undefined : byId.get(target);

  function handleSend() {
    const value = text.trim();
    if (!value) return;
    // Cleared immediately (M4). It used to be held until the send resolved, so
    // that a failure left the words in the box — but the reply is now a bubble
    // in the strand the moment you tap Send, and a failure turns *that* into a
    // failed bubble with Retry beside it. Keeping the text in the composer as
    // well would show the same message twice and make it possible to send it
    // twice.
    const mentionIds = mentions.idsFor(value);
    setText('');
    mentions.reset();
    // Whichever message got you here. The server flattens it into this strand
    // either way (`thread_root` is derived, one level deep), so naming the real
    // target costs nothing and keeps the quote honest.
    //
    // The rejection is handled by the caller's mutation, which is what owns the
    // outbox entry — catching here only stops an unhandled rejection.
    onSend(value, target, mentionIds).catch(() => {});
  }

  return (
    <Modal
      transparent
      visible
      animationType="fade"
      onRequestClose={onClose}
      accessibilityViewIsModal
    >
      <BlurView intensity={28} tint="light" style={StyleSheet.absoluteFill}>
        {/* A wash over the blur: on a light surface, blur alone doesn't drop the
            transcript back far enough for the thread to read as the foreground.

            On Android it isn't "over the blur", because there is no blur — see
            the note on `washAndroid`, which is why the two are different
            strengths rather than one shared value. */}
        <View
          testID="thread-wash"
          style={Platform.OS === 'android' ? styles.washAndroid : styles.wash}
        />

        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close thread"
        />

        <KeyboardAvoider
          style={[styles.sheet, { paddingTop: insets.top + spacing.sm }]}
          pointerEvents="box-none"
        >
          <View style={styles.header} pointerEvents="auto">
            <Text style={styles.title}>Thread</Text>
            <Pressable
              onPress={onClose}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Close thread"
            >
              <Text style={styles.done}>Done</Text>
            </Pressable>
          </View>

          {threadQuery.isLoading ? (
            <ActivityIndicator color={colors.accent} style={styles.spinner} />
          ) : (
            <FlatList
              ref={listRef}
              // Named for the same reason the transcript is: a test can't reach
              // a list through an accessibility label, and the scroll behaviour
              // below is only reachable by driving its props.
              testID="strand"
              data={messages}
              style={styles.list}
              contentContainerStyle={styles.listContent}
              keyExtractor={(m) => String(m.id)}
              // Oldest-first, like the transcript — so keep the newest reply in
              // view as later pages land and as replies arrive. Without this a
              // strand longer than the screen opens at the root and the reply
              // you just sent is off the bottom.
              //
              // **Twice, and the second one is the one Android needs** (Phase
              // 10). `scrollToEnd` is a command to the *native* list, and on
              // Android it arrives before the new content height has been
              // committed — so it scrolls to a bottom that is still the old one,
              // which on a strand that has just opened is 0. Nothing fires
              // afterwards to correct it (the next event is a `layout`, not a
              // content size), so the strand sat at the root with its newest
              // replies under the composer. A frame later the height is there.
              //
              // iOS commits synchronously and is already at the end by then, so
              // the deferred call is a no-op rather than a second jump — which
              // is why the immediate one stays rather than being replaced.
              onContentSizeChange={() => {
                listRef.current?.scrollToEnd({ animated: false });
                requestAnimationFrame(() =>
                  listRef.current?.scrollToEnd({ animated: false })
                );
              }}
              ListHeaderComponent={
                // Only when the root itself is clipped out — the replies below
                // are ones this viewer *is* entitled to, so the thread is
                // genuinely headless rather than empty.
                //
                // Never on a failure, which its web twin has always been gated
                // on and this one now needs to be: a missing root is a claim
                // about *permission*, and until #248 a failed fetch cleared
                // itself within a render or two because the broken walk kept
                // re-firing. Now the flag is sticky until a poll gets through,
                // so an unsent reply against a strand that didn't load would
                // hold this on screen — telling you you're not entitled to a
                // message the network merely failed to fetch.
                !root && !threadQuery.isError && messages.length > 0 ? (
                  <Text style={styles.missingRoot}>
                    The start of this thread isn’t available to you
                  </Text>
                ) : null
              }
              renderItem={({ item }) => {
                const status = statusFor?.(item);
                // Retry and Discard belong to a reply the server hasn't taken
                // yet, and the status says so — `sending` and `failed` are the
                // outbox's two states, where anything loaded is `sent`, `read`
                // or nothing at all. Asking the status beats testing the id's
                // sign: the negative temp id is the outbox's own business, and
                // this view doesn't own the outbox.
                const unsent = status === 'sending' || status === 'failed';
                return (
                  // No onLongPress and no onOpenThread: see the file docblock.
                  // You're already in the thread, and the menu is a modal.
                  //
                  // No `onPhotoPress` either (Phase 9b M7), and for the same
                  // reason: this view *is* a Modal, and the lightbox is another
                  // one — two visible modals stack badly on iOS, the trap
                  // `ReactionTray` documents. A photo in a strand therefore
                  // draws but doesn't open, and `MessagePhoto` renders no
                  // affordance when it can't be pressed, so nothing here
                  // promises a tap that does nothing. The transcript behind the
                  // blur has the same photo, one tap away.
                  <MessageBubble
                    message={item}
                    mine={item.sender.id === meId}
                    // Every bubble in here is attributed in a group, including
                    // runs: the strand is short and read out of its
                    // chronological context, so "who said this" is worth the
                    // repetition.
                    showSender={isGroup && item.sender.id !== meId}
                    // Plain bubbles in here (M9g): no strand edge, no quote.
                    // Everything in this list belongs to the one thread, so a
                    // mark saying so on each bubble would say nothing, and a
                    // quote would repeat words that are already on screen a few
                    // rows up. What you're answering is named above the
                    // composer instead, and only when it isn't the root.
                    insideStrand
                    status={status}
                    mentionNames={mentionNames}
                    onRetry={unsent ? () => onRetry?.(item) : undefined}
                    onDiscard={unsent ? () => onDiscard?.(item) : undefined}
                  />
                );
              }}
              ListEmptyComponent={
                // Only claim the thread is clipped when we actually heard back.
                // A failed fetch is a different thing entirely, and telling
                // someone they aren't entitled to a message when the network
                // merely dropped devalues the message where it's true.
                threadQuery.isError ? (
                  <Text style={styles.missingRoot}>
                    Couldn’t load this thread. Close and try again.
                  </Text>
                ) : (
                  <Text style={styles.missingRoot}>
                    The start of this thread isn’t available to you
                  </Text>
                )
              }
              ListFooterComponent={
                // A stopped walk (#248) leaves the strand clipped at its
                // *oldest* replies, so the gap is at this end — the newest
                // replies, and the count on the root will have gone on climbing
                // past what's here. Say so instead of letting it read as the
                // whole thread. The poll clears it on its own once a fetch gets
                // through.
                //
                // Which of the two lines depends on `loaded`, not `messages`:
                // `messages` counts unsent replies too, so a strand where
                // *nothing* came back but you've queued a reply anyway isn't
                // empty as far as the list is concerned, and the branch below
                // never runs. Saying "the newest replies" there would claim a
                // tail is missing when in fact none of it arrived.
                threadQuery.isError && messages.length > 0 ? (
                  <Text style={styles.pagesFailed}>
                    {loaded.length > 0
                      ? 'Couldn’t load the newest replies.'
                      : 'Couldn’t load this thread. Close and try again.'}
                  </Text>
                ) : null
              }
            />
          )}

          <View
            style={[
              styles.composerBar,
              { paddingBottom: spacing.sm + 2 + (keyboardVisible ? 0 : insets.bottom) },
            ]}
            pointerEvents="auto"
          >
            {canSend ? (
              <>
                {answering ? (
                  <Text style={styles.answering} numberOfLines={1}>
                    Replying to {answering.sender.display_name}
                  </Text>
                ) : null}
                <MentionSuggestions
                  people={mentions.suggestions}
                  onChoose={mentions.choose}
                />
                <View style={styles.composer}>
                  <TextInput
                    value={text}
                    onChangeText={mentions.onChangeText}
                    onSelectionChange={(event) =>
                      mentions.onSelectionChange(
                        event.nativeEvent.selection.start
                      )
                    }
                    placeholder="Reply to thread…"
                    placeholderTextColor={colors.inkFaint}
                    multiline
                    // Reply put you here, so don't make the keyboard a second
                    // tap. Browsing in from a reply count doesn't, because you
                    // came to read.
                    autoFocus={composing}
                    style={styles.input}
                    accessibilityLabel="Reply to thread"
                  />
                  {/* Never disabled by a send in flight (M4): each reply gets
                      its own outbox entry, so a quick second one doesn't have
                      to wait for the first to come back. */}
                  <Pressable
                    onPress={handleSend}
                    disabled={!text.trim()}
                    accessibilityRole="button"
                    accessibilityLabel="Send reply"
                    style={({ pressed }) => [
                      styles.send,
                      !text.trim() && styles.sendDisabled,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={styles.sendLabel}>Send</Text>
                  </Pressable>
                </View>
                {/* No error line here any more (M4). A reply that fails says so
                    on the bubble it failed as, next to Retry and Discard —
                    which is nearer the thing that went wrong, and the only
                    place that still works when two replies are in flight and
                    just one of them fell over. */}
              </>
            ) : (
              <Text style={styles.readonly}>
                You can’t send messages in this conversation.
              </Text>
            )}
          </View>
        </KeyboardAvoider>
      </BlurView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wash: {
    ...StyleSheet.absoluteFill,
    // `colors.surface` with an alpha — RN has no colour-with-opacity helper, so
    // the token is spelled out. Both literals here must follow it if it moves.
    backgroundColor: 'rgba(251,250,247,0.55)',
  },
  // Android gets a near-solid wash because `expo-blur` gives it no blur at all:
  // `blurMethod` defaults to `'none'` (a flat translucent tint), and turning it
  // on needs a `<BlurTargetView>` wrapping the content to be blurred *in the
  // same window* — which a `Modal` is not, it's a window of its own. So on
  // Android the strand was floating over a perfectly legible transcript at
  // roughly 35% show-through, and two conversations' worth of text overlapped:
  // the "messy" look this fixes.
  //
  // A blur can be light because it destroys the detail behind it; a wash can't,
  // so it has to be heavy enough to do the same job. **What lands on screen is
  // ~5% show-through, not the 6% this alpha alone would give**: the `BlurView`
  // is still mounted underneath and contributes its own flat tint (~0.22 at
  // `intensity={28}`), so the two compose. Measured on a Pixel 8 emulator, ink
  // behind the wash reads (240,239,236) against a (251,250,247) ground. That
  // margin is deliberate — the transcript's colour stays faintly present, so it
  // still reads as this conversation pushed back rather than a screen you
  // navigated to. Tune this number against the composite, not on its own.
  washAndroid: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(251,250,247,0.94)',
  },
  sheet: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  title: { fontSize: fontSize.base, fontWeight: '700', color: colors.ink },
  done: { fontSize: fontSize.sm, fontWeight: '600', color: colors.accent },
  spinner: { marginTop: spacing.xl },
  // The strand floats on the blur with no card behind it — a panel would put a
  // second surface between you and a conversation you never left.
  list: { flex: 1 },
  listContent: { padding: spacing.md, flexGrow: 1, justifyContent: 'flex-end' },
  missingRoot: {
    marginBottom: spacing.sm,
    fontSize: fontSize.sm,
    fontStyle: 'italic',
    color: colors.inkFaint,
    textAlign: 'center',
  },
  pagesFailed: {
    marginTop: spacing.sm,
    fontSize: fontSize.sm,
    color: colors.danger,
    textAlign: 'center',
  },
  composerBar: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.sm + 2,
    paddingTop: spacing.sm + 2,
  },
  answering: {
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.xs,
    fontSize: fontSize.sm - 1,
    fontWeight: '600',
    color: colors.inkSoft,
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
    paddingVertical: spacing.xs,
  },
  pressed: { opacity: 0.7 },
});
