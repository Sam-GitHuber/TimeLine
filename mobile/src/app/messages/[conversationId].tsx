/**
 * A single conversation thread — 1:1 or group. Ported from the web's
 * `ConversationThreadView` (in `MessagesDrawer.jsx`), but a full-screen route
 * pushed over the tab bar rather than a drawer view (the E2 structure decision).
 *
 * What it does:
 *   - loads the conversation detail (the header identity + `can_send` +
 *     `my_status`, which the messages list doesn't carry) and the messages;
 *   - polls the messages on the fast cadence (`MESSAGE_POLL_MS`);
 *   - marks the thread read on open and as new messages land, clearing the
 *     per-thread pill and the tab badge;
 *   - sends, and offers the **long-press action menu** on any bubble — Copy /
 *     Edit / Delete on your own, Copy / Report on someone else's (Phase 9b M1);
 *   - a *group* header offers Leave; a 1:1 header links to the other's profile;
 *   - a **pending** viewer (added but not yet connected to the whole clique) sees
 *     the locked `PendingChatPanel` instead of the message list;
 *   - a viewer who can no longer send (disconnected) gets a read-only footer;
 *   - keeps the newest message in view.
 *
 * **Add people is E2b**, so a group header carries only Leave here; the composer
 * for a new chat and add-people land with the create half of E2.
 */

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
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
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { api, ApiError, MESSAGE_EDIT_WINDOW_MS, MESSAGE_POLL_MS } from '@/api';
import { useAuth } from '@/auth';
import { Avatar } from '@/components/Avatar';
import { AvatarStack } from '@/components/AvatarStack';
import type { BubbleAnchor, MessageAction } from '@/components/MessageActionMenu';
import { MessageActionMenu } from '@/components/MessageActionMenu';
import { MessageBubble } from '@/components/MessageBubble';
import { PendingChatPanel } from '@/components/PendingChatPanel';
import { ReportModal } from '@/components/ReportModal';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { Message } from '@/types';

/** The composer bar's base vertical padding, before the home-indicator inset. */
const COMPOSER_PAD = spacing.sm + 2;

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
  onEdit,
  onDelete,
  onReport,
}: {
  message: Message;
  mine: boolean;
  canSend: boolean;
  now: number;
  onEdit: (message: Message) => void;
  onDelete: (messageId: number) => void;
  onReport: (messageId: number) => void;
}): MessageAction[] {
  const actions: MessageAction[] = [
    { label: 'Copy', onPress: () => Clipboard.setStringAsync(message.text) },
  ];
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
  // Whatever was half-typed when edit mode started, put back on cancel. Losing
  // a draft to a typo fix would be its own small betrayal.
  const [stashedDraft, setStashedDraft] = useState('');
  const [reportingId, setReportingId] = useState<number | null>(null);

  const goBack = () =>
    router.canGoBack() ? router.back() : router.replace('/messages');

  const convoQuery = useQuery({
    queryKey: ['conversation', id],
    queryFn: () => api.getConversation(id),
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

  const messages = messagesQuery.data?.pages.flatMap((page) => page.results) ?? [];
  const messageCount = messages.length;

  // Mark read on open and as new messages land, clearing the tab badge and this
  // thread's pill. Guarded on error so a failed load doesn't clear the badge.
  useEffect(() => {
    if (convoQuery.isError || isPending) return;
    api.markConversationRead(id).then(() => {
      queryClient.invalidateQueries({ queryKey: ['unreadMessages'] });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    });
  }, [id, messageCount, convoQuery.isError, isPending, queryClient]);

  const sendMutation = useMutation({
    mutationFn: (value: string) => api.sendMessage(id, value),
    onSuccess: () => {
      setText('');
      queryClient.invalidateQueries({ queryKey: ['messages', id] });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });

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

  const busy = sendMutation.isPending || editMutation.isPending;

  /** Send a new message, or save the one being edited — the composer does both. */
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
    sendMutation.mutate(value);
  }

  function startEditing(message: Message) {
    setStashedDraft(text);
    setEditing(message);
    setText(message.text);
    editMutation.reset();
    // Focus after the composer has re-rendered into edit mode.
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  /** Leave edit mode and put the pre-edit draft back in the composer. */
  function stopEditing() {
    setEditing(null);
    setText(stashedDraft);
    setStashedDraft('');
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
              return (
                <MessageBubble
                  message={item}
                  mine={mine}
                  showSender={isGroup && !mine && startsRun}
                  onLongPress={(anchor) =>
                    setMenuTarget({
                      message: item,
                      mine,
                      anchor,
                      actions: messageActions({
                        message: item,
                        mine,
                        canSend,
                        now: Date.now(),
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
                    <Text style={styles.sendLabel}>
                      {editing
                        ? editMutation.isPending
                          ? 'Saving…'
                          : 'Save'
                        : sendMutation.isPending
                          ? 'Sending…'
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
            {sendMutation.isError && (
              <Text style={styles.sendError}>
                {sendMutation.error instanceof Error
                  ? sendMutation.error.message
                  : "Couldn't send. Try again."}
              </Text>
            )}
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

      {menuTarget ? (
        <MessageActionMenu
          message={menuTarget.message}
          mine={menuTarget.mine}
          anchor={menuTarget.anchor}
          actions={menuTarget.actions}
          onClose={() => setMenuTarget(null)}
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
