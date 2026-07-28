/**
 * The focused reply thread (Phase 9b M3).
 *
 * Blurs the transcript and brings a whole mini-conversation forward: the root at
 * the top, every reply under it, a composer pinned below that sends straight
 * back into the thread.
 *
 * **Every route to a reply comes through here**, whether you tapped "3 replies"
 * on a root, tapped a reply's quote, or hit Reply on a message that has no
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
 * to reorder itself around it. The collapsed quote still exists — it's what you
 * tap.
 *
 * **The blur is doing real work, and isn't decoration.** A plain dim scrim reads
 * as "a modal over a list"; the blur reads as the same conversation pushed out of
 * focus, which is the whole point — you haven't gone anywhere, you've narrowed to
 * a strand of the thread you're already in.
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
 * to and no head. That renders as "Original message unavailable" rather than an
 * error, because nothing has gone wrong — see `messaging.md`.
 */

import { useInfiniteQuery } from '@tanstack/react-query';
import { BlurView } from 'expo-blur';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MessageBubble } from './MessageBubble';
import { api, MESSAGE_POLL_MS } from '@/api';
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
   * so a reply to a reply quotes the person you meant rather than whoever
   * happened to start the strand.
   */
  replyToId?: number;
  /** Reply brought you here, so open with the keyboard already up. */
  composing?: boolean;
  meId?: number;
  isGroup: boolean;
  canSend: boolean;
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
  onSend: (text: string, replyToId: number) => Promise<unknown>;
  onRetry?: (message: Message) => void;
  onDiscard?: (message: Message) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList<Message>>(null);
  const [text, setText] = useState('');

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
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = threadQuery;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

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
    setText('');
    // Whichever message got you here. The server flattens it into this strand
    // either way (`thread_root` is derived, one level deep), so naming the real
    // target costs nothing and keeps the quote honest.
    //
    // The rejection is handled by the caller's mutation, which is what owns the
    // outbox entry — catching here only stops an unhandled rejection.
    onSend(value, target).catch(() => {});
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
            transcript back far enough for the thread to read as the foreground. */}
        <View style={styles.wash} />

        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close thread"
        />

        <KeyboardAvoidingView
          style={[styles.sheet, { paddingTop: insets.top + spacing.sm }]}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
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
              data={messages}
              style={styles.list}
              contentContainerStyle={styles.listContent}
              keyExtractor={(m) => String(m.id)}
              // Oldest-first, like the transcript — so keep the newest reply in
              // view as later pages land and as replies arrive. Without this a
              // strand longer than the screen opens at the root and the reply
              // you just sent is off the bottom.
              onContentSizeChange={() =>
                listRef.current?.scrollToEnd({ animated: false })
              }
              ListHeaderComponent={
                // Only when the root itself is clipped out — the replies below
                // are ones this viewer *is* entitled to, so the thread is
                // genuinely headless rather than empty.
                !root && messages.length > 0 ? (
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
                  <MessageBubble
                    message={item}
                    mine={item.sender.id === meId}
                    // Every bubble in here is attributed in a group, including
                    // runs: the strand is short and read out of its
                    // chronological context, so "who said this" is worth the
                    // repetition.
                    showSender={isGroup && item.sender.id !== meId}
                    quoted={
                      item.reply_to ? byId.get(item.reply_to.id) : undefined
                    }
                    status={status}
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
            />
          )}

          <View
            style={[
              styles.composerBar,
              { paddingBottom: spacing.sm + 2 + insets.bottom },
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
                <View style={styles.composer}>
                  <TextInput
                    value={text}
                    onChangeText={setText}
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
        </KeyboardAvoidingView>
      </BlurView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wash: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(251,250,247,0.55)',
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
