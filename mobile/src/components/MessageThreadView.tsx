/**
 * The focused reply thread (Phase 9b M3).
 *
 * Tapping "3 replies" under a message blurs the transcript and brings that whole
 * mini-conversation forward: the root at the top, every reply under it, a
 * composer pinned below that sends straight back into the thread.
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

import { useQuery } from '@tanstack/react-query';
import { BlurView } from 'expo-blur';
import { useState } from 'react';
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
import { colors, fontSize, radius, spacing } from '@/theme';

export function threadQueryKey(conversationId: number, rootId: number) {
  return ['thread', conversationId, rootId] as const;
}

export function MessageThreadView({
  conversationId,
  rootId,
  meId,
  isGroup,
  canSend,
  sending,
  onSend,
  onClose,
}: {
  conversationId: number;
  /** The thread's root message id — what the transcript's branch links to. */
  rootId: number;
  meId?: number;
  isGroup: boolean;
  canSend: boolean;
  sending: boolean;
  /**
   * Send into this thread. The caller owns the mutation (and so the cache
   * invalidation), because a reply is an ordinary message and has to land in the
   * transcript as well as here.
   */
  onSend: (text: string, replyToId: number) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');

  // Polled like the transcript, so a reply someone else sends while you're
  // reading the strand appears in it rather than only behind the blur.
  const threadQuery = useQuery({
    queryKey: threadQueryKey(conversationId, rootId),
    queryFn: () => api.getThread(conversationId, rootId),
    refetchInterval: MESSAGE_POLL_MS,
  });
  const messages = threadQuery.data?.results ?? [];
  const byId = new Map(messages.map((m) => [m.id, m]));
  const root = byId.get(rootId);

  function handleSend() {
    const value = text.trim();
    if (!value || sending) return;
    // Replies from in here answer the *root*, which is what the flattening rule
    // would resolve them to anyway — the server derives `thread_root` from
    // whatever we send, so this is the honest target rather than a guess.
    onSend(value, rootId);
    setText('');
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
              data={messages}
              style={styles.list}
              contentContainerStyle={styles.listContent}
              keyExtractor={(m) => String(m.id)}
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
              renderItem={({ item }) => (
                // No onLongPress and no onOpenThread: see the file docblock.
                // You're already in the thread, and the menu is a modal.
                <MessageBubble
                  message={item}
                  mine={item.sender.id === meId}
                  // Every bubble in here is attributed in a group, including
                  // runs: the strand is short and read out of its chronological
                  // context, so "who said this" is worth the repetition.
                  showSender={isGroup && item.sender.id !== meId}
                  quoted={
                    item.reply_to ? byId.get(item.reply_to.id) : undefined
                  }
                />
              )}
              ListEmptyComponent={
                <Text style={styles.missingRoot}>
                  The start of this thread isn’t available to you
                </Text>
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
              <View style={styles.composer}>
                <TextInput
                  value={text}
                  onChangeText={setText}
                  placeholder="Reply to thread…"
                  placeholderTextColor={colors.inkFaint}
                  multiline
                  style={styles.input}
                  accessibilityLabel="Reply to thread"
                />
                <Pressable
                  onPress={handleSend}
                  disabled={!text.trim() || sending}
                  accessibilityRole="button"
                  accessibilityLabel="Send reply"
                  style={({ pressed }) => [
                    styles.send,
                    (!text.trim() || sending) && styles.sendDisabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.sendLabel}>
                    {sending ? 'Sending…' : 'Send'}
                  </Text>
                </Pressable>
              </View>
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
