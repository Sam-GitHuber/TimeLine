/**
 * A conversation's info screen (Phase 9b M6) — everything *about* a chat, as
 * opposed to what was said in it.
 *
 * **Why it exists.** The thread header had grown Mute, Add and Leave as three
 * cramped text buttons competing with the name of the person you're talking to,
 * which is the one thing a chat header is for. Moving them here is both the
 * standard shape and simply better: the header becomes identity + `⋯`, and the
 * actions get room to say what they do. It's also the only place a **group can
 * be renamed** — until M6 a title was fixed at creation, so "Weekend plans"
 * outlived the weekend.
 *
 * What's here:
 *   - identity — the group's (editable) name, or the other person, tappable
 *     through to their profile;
 *   - the participant list, with a **Pending** badge for anyone still in the
 *     waiting room (see messaging.md's clique invariant — a pending member is
 *     someone who isn't yet connected to everyone else, not someone ignoring an
 *     invitation);
 *   - Mute, Add people (group), Leave, and — on a 1:1 — Block.
 *
 *   - **the media gallery** (Phase 9b M7) — every photo in the chat, newest
 *     first, which is the answer to "the picture someone sent last week"
 *     without scrolling a year of transcript. It was written into M6's plan and
 *     deliberately left out of M6: there were no photo messages until M7, and an
 *     empty grid promising a feature that doesn't exist is worse than its
 *     absence.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api } from '@/api';
import { useAuth } from '@/auth';
import { Avatar } from '@/components/Avatar';
import { AvatarStack } from '@/components/AvatarStack';
import { AuthedImage } from '@/components/AuthedImage';
import { BlockButton } from '@/components/BlockButton';
import { KeyboardAwareScroll } from '@/components/KeyboardAvoider';
import { PhotoLightbox } from '@/components/PhotoLightbox';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { MessageAttachment, Participant } from '@/types';

export default function ConversationInfoScreen() {
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const id = Number(conversationId);
  const { user: me } = useAuth();
  const queryClient = useQueryClient();
  /** The in-progress rename, or null when the name is just being displayed. */
  const [draftTitle, setDraftTitle] = useState<string | null>(null);

  /**
   * The same query key the thread uses, so opening this screen costs nothing
   * when you arrived from there and any change made here is on the thread's
   * header the moment you go back.
   *
   * Not polled: this screen shows membership and settings, which change when
   * *you* change them, and the read receipts that make the thread poll the same
   * payload have nothing to draw here.
   */
  const convoQuery = useQuery({
    queryKey: ['conversation', id],
    queryFn: () => api.getConversation(id),
  });
  const detail = convoQuery.data;
  const isGroup = detail?.kind === 'group';
  const canRename = isGroup && detail?.my_status === 'active';
  const other = detail?.other;

  /**
   * The other person's profile — for the Block control, which needs to know
   * whether you've already blocked them.
   *
   * One extra request, only on a 1:1, and only on this screen. Blocking is
   * reachable from a profile too (App Review requires that, and it's where it
   * has always lived); having it here as well is the point of an info screen —
   * the moment you want to block someone is usually the moment you're looking
   * at what they sent.
   */
  const otherQuery = useQuery({
    queryKey: ['user', other?.id],
    queryFn: () => api.getUser(other!.id),
    enabled: !!other?.id,
  });

  const renameMutation = useMutation({
    mutationFn: (title: string) => api.renameConversation(id, title),
    onSuccess: (updated) => {
      setDraftTitle(null);
      // Write the server's copy straight into the cache the thread header reads
      // from, then refresh the list — where the row's name is the *only* thing
      // that changed, since a rename deliberately doesn't reorder it.
      queryClient.setQueryData(['conversation', id], updated);
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
    onError: (error) =>
      Alert.alert(
        'Couldn’t rename this chat',
        error instanceof Error ? error.message : 'Something went wrong.'
      ),
  });

  const muteMutation = useMutation({
    mutationFn: (muted: boolean) => api.setConversationMuted(id, muted),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversation', id] });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });

  const leaveMutation = useMutation({
    mutationFn: () => api.leaveConversation(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      queryClient.invalidateQueries({ queryKey: ['unreadMessages'] });
      // **Past the thread, not back to it.** The thread's own Leave could
      // `goBack()` because the list was one screen down; from here that lands
      // on the transcript of a conversation you're no longer in — a 404 waiting
      // to happen. `dismissTo` pops until it finds the list, which is where
      // you'd expect to be standing afterwards.
      if (router.canDismiss?.()) router.dismissTo('/messages');
      else router.replace('/messages');
    },
  });

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

  const groupName =
    detail?.title ||
    (detail?.participants ?? [])
      .filter((p) => p.id !== me?.pk)
      .map((p) => p.display_name)
      .join(', ') ||
    'Group chat';

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.topBar}>
        <Pressable
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/messages'))}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={8}
        >
          <Text style={styles.back}>← Back</Text>
        </Pressable>
        <Text style={styles.topTitle}>Details</Text>
        <View style={styles.spacer} />
      </View>

      {convoQuery.isLoading ? (
        <ActivityIndicator color={colors.accent} style={styles.spinner} />
      ) : !detail ? (
        <View style={styles.centre}>
          <Text style={styles.emptyTitle}>
            This conversation isn’t available.
          </Text>
        </View>
      ) : (
        <KeyboardAwareScroll
          style={styles.fill}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.identity}>
            {isGroup ? (
              <AvatarStack participants={detail.participants} max={3} />
            ) : (
              <Avatar user={other} size="lg" />
            )}

            {draftTitle !== null ? (
              // Editing in place rather than on a screen of its own: it's one
              // field, and a round trip through a form would be more
              // navigation than the change deserves.
              <View style={styles.renameRow}>
                <TextInput
                  value={draftTitle}
                  onChangeText={setDraftTitle}
                  placeholder="Name this chat"
                  placeholderTextColor={colors.inkFaint}
                  accessibilityLabel="Chat name"
                  autoFocus
                  maxLength={100}
                  style={styles.renameInput}
                />
                <Pressable
                  onPress={() => setDraftTitle(null)}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel rename"
                  hitSlop={8}
                >
                  <Text style={styles.renameCancel}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={() => renameMutation.mutate(draftTitle.trim())}
                  disabled={renameMutation.isPending}
                  accessibilityRole="button"
                  accessibilityLabel="Save name"
                  hitSlop={8}
                >
                  <Text style={styles.renameSave}>
                    {renameMutation.isPending ? 'Saving…' : 'Save'}
                  </Text>
                </Pressable>
              </View>
            ) : (
              <>
                <Text style={styles.name} numberOfLines={2}>
                  {isGroup ? groupName : other?.display_name ?? 'Conversation'}
                </Text>
                {canRename ? (
                  <Pressable
                    onPress={() => setDraftTitle(detail.title ?? '')}
                    accessibilityRole="button"
                    accessibilityLabel="Rename chat"
                    hitSlop={8}
                  >
                    <Text style={styles.link}>Rename</Text>
                  </Pressable>
                ) : null}
                {!isGroup && other ? (
                  <Pressable
                    onPress={() => router.push(`/u/${other.id}`)}
                    accessibilityRole="button"
                    accessibilityLabel={`View ${other.display_name}’s profile`}
                    hitSlop={8}
                  >
                    <Text style={styles.link}>View profile</Text>
                  </Pressable>
                ) : null}
              </>
            )}

            {detail.group ? (
              <Text style={styles.groupScope}>
                In the group {detail.group.name}
              </Text>
            ) : null}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              {isGroup
                ? `${detail.participants.length} people`
                : 'In this chat'}
            </Text>
            {detail.participants.map((person) => (
              <PersonRow key={person.id} person={person} meId={me?.pk} />
            ))}
          </View>

          <MediaGallery conversationId={id} />

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Settings</Text>

            {/* Mute reads as its state, not as an imperative — a muted thread
                should say so, since the whole risk of muting is forgetting
                you did. It silences the buzz only: the thread keeps its
                unread badge either way. */}
            <Pressable
              onPress={() => muteMutation.mutate(!detail.muted)}
              disabled={muteMutation.isPending}
              accessibilityRole="switch"
              accessibilityLabel="Mute notifications"
              accessibilityState={{ checked: detail.muted }}
              style={({ pressed }) => [styles.action, pressed && styles.pressed]}
            >
              <View style={styles.actionText}>
                <Text style={styles.actionLabel}>
                  {detail.muted ? 'Muted' : 'Mute notifications'}
                </Text>
                <Text style={styles.actionHint}>
                  {detail.muted
                    ? 'This chat won’t buzz your phone. It still shows unread.'
                    : 'Stop this chat buzzing your phone.'}
                </Text>
              </View>
              <Text style={styles.actionState}>
                {detail.muted ? 'On' : 'Off'}
              </Text>
            </Pressable>

            {isGroup ? (
              <Pressable
                onPress={() => router.push(`/messages/new?addTo=${id}`)}
                accessibilityRole="button"
                accessibilityLabel="Add people"
                style={({ pressed }) => [styles.action, pressed && styles.pressed]}
              >
                <View style={styles.actionText}>
                  <Text style={styles.actionLabel}>Add people</Text>
                  <Text style={styles.actionHint}>
                    Anyone you’re connected with. They join once they’re
                    connected to everyone here.
                  </Text>
                </View>
              </Pressable>
            ) : null}
          </View>

          <View style={styles.section}>
            {isGroup ? (
              <Pressable
                onPress={confirmLeave}
                disabled={leaveMutation.isPending}
                accessibilityRole="button"
                accessibilityLabel="Leave chat"
                style={({ pressed }) => [styles.action, pressed && styles.pressed]}
              >
                <View style={styles.actionText}>
                  <Text style={[styles.actionLabel, styles.danger]}>
                    Leave chat
                  </Text>
                  <Text style={styles.actionHint}>
                    You’ll stop receiving messages here.
                  </Text>
                </View>
              </Pressable>
            ) : null}

            {/* Block is the strong, explicit cut — it severs the connection,
                hides the thread from both of you and bars re-connecting. The
                shared control owns the warning modal, so this screen doesn't
                hold a second copy of what blocking costs. */}
            {!isGroup && other && otherQuery.data ? (
              <View style={styles.blockRow}>
                <BlockButton
                  userId={other.id}
                  displayName={other.display_name}
                  isBlocked={otherQuery.data.is_blocked}
                />
              </View>
            ) : null}
          </View>
        </KeyboardAwareScroll>
      )}
    </SafeAreaView>
  );
}

/**
 * Every photo in this chat, newest first (Phase 9b M7).
 *
 * **It renders nothing at all when there are no photos**, rather than an empty
 * state — a heading over a blank square is a feature announcing that it has
 * nothing for you. A chat that has never carried a picture simply doesn't have
 * this section, and it appears the first time one is sent.
 *
 * 🔒 It reads the *messages* endpoint with a `media=1` filter, not a gallery
 * endpoint of its own, so the photos here are the same interval-clipped set the
 * transcript draws from and the gallery can't become a way to see round a gap in
 * someone's membership. See `getConversationMedia`.
 *
 * One page, deliberately: this is a summary panel inside a scroll view, and
 * nesting a paging grid inside it would fight the outer scroll for the gesture.
 * A page is 20 photos, which at family scale is most chats entirely — and the
 * transcript is still there for older ones.
 */
function MediaGallery({ conversationId }: { conversationId: number }) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const mediaQuery = useQuery({
    queryKey: ['conversation-media', conversationId],
    queryFn: () => api.getConversationMedia(conversationId),
  });

  // Flattened out of their messages: the grid is about pictures, not about which
  // message each arrived in. Ordering follows the response (newest message
  // first), so the newest photo is top-left.
  const photos: MessageAttachment[] = (mediaQuery.data?.results ?? []).flatMap(
    (message) => message.attachments ?? []
  );

  if (photos.length === 0) return null;

  /**
   * How many photos the chat holds, which is **not** how many are drawn below.
   *
   * The grid is one page; the heading is a fact about the conversation, so it
   * comes from the paginated `count` rather than from `photos.length` — which
   * would tell someone with sixty photos that they have twenty, in a confident
   * voice, because that's how many fit on a page.
   *
   * `count` is a count of *messages* carrying a photo. That's the same number
   * while `MESSAGE_ATTACHMENTS_MAX` is 1 (see messaging.md); if that cap is ever
   * raised, this becomes an undercount and wants a real photo count from the
   * server rather than a fudge here.
   */
  const total = mediaQuery.data?.count ?? photos.length;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>
        {total === 1 ? '1 photo' : `${total} photos`}
      </Text>
      <View style={styles.grid}>
        {photos.map((photo, index) => (
          <Pressable
            key={photo.id}
            onPress={() => setLightboxIndex(index)}
            accessibilityRole="imagebutton"
            accessibilityLabel={`Photo ${index + 1} of ${photos.length}`}
            style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
          >
            <AuthedImage
              uri={photo.thumbnail}
              style={styles.tileImage}
              contentFit="cover"
              transition={120}
            />
          </Pressable>
        ))}
      </View>

      {/* Here the viewer *is* a gallery — you swipe between the chat's photos,
          which is exactly what you came to this screen to do. (From a bubble it
          opens the single photo, because there the message is the unit.) */}
      {lightboxIndex !== null ? (
        <PhotoLightbox
          images={photos.map((photo) => ({
            id: photo.id,
            image: photo.url,
            thumbnail: photo.thumbnail,
            width: photo.width,
            height: photo.height,
          }))}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      ) : null}
    </View>
  );
}

function PersonRow({
  person,
  meId,
}: {
  person: Participant;
  meId: number | undefined;
}) {
  const isMe = person.id === meId;
  return (
    <Pressable
      onPress={isMe ? undefined : () => router.push(`/u/${person.id}`)}
      accessibilityRole={isMe ? undefined : 'button'}
      accessibilityLabel={isMe ? undefined : `View ${person.display_name}’s profile`}
      style={({ pressed }) => [styles.person, pressed && !isMe && styles.pressed]}
    >
      <Avatar user={person} size="sm" />
      <Text style={styles.personName} numberOfLines={1}>
        {person.display_name}
        {isMe ? ' (you)' : ''}
      </Text>
      {person.status === 'pending' ? (
        // Not "hasn't replied" — a pending member is waiting on *connections*,
        // which is the clique invariant doing its job rather than someone
        // ignoring an invitation.
        <Text style={styles.pendingBadge}>Pending</Text>
      ) : null}
    </Pressable>
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
  topTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: fontSize.base,
    fontWeight: '700',
    color: colors.ink,
  },
  spacer: { width: 56 },
  spinner: { marginTop: spacing.xl },
  content: { paddingBottom: spacing.xl },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyTitle: { fontSize: fontSize.base, fontWeight: '600', color: colors.ink },
  identity: {
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.md,
  },
  name: {
    marginTop: spacing.xs,
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.ink,
    textAlign: 'center',
  },
  link: { fontSize: fontSize.sm, color: colors.accent, fontWeight: '600' },
  groupScope: { fontSize: fontSize.sm, color: colors.inkFaint },
  renameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    alignSelf: 'stretch',
    marginTop: spacing.sm,
  },
  renameInput: {
    flex: 1,
    height: 40,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.md,
    backgroundColor: colors.raised,
    paddingHorizontal: spacing.sm + 2,
    fontSize: fontSize.base,
    color: colors.ink,
  },
  renameCancel: { fontSize: fontSize.sm, color: colors.inkFaint, fontWeight: '600' },
  renameSave: { fontSize: fontSize.sm, color: colors.accent, fontWeight: '700' },
  section: {
    marginTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingTop: spacing.sm,
  },
  sectionTitle: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    fontSize: fontSize.sm - 1,
    fontWeight: '700',
    color: colors.inkFaint,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  person: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  personName: { flex: 1, fontSize: fontSize.base, color: colors.ink },
  pendingBadge: {
    fontSize: fontSize.sm - 1,
    fontWeight: '700',
    color: colors.inkFaint,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  actionText: { flex: 1, gap: 2 },
  actionLabel: { fontSize: fontSize.base, color: colors.ink, fontWeight: '600' },
  actionHint: { fontSize: fontSize.sm, color: colors.inkFaint, lineHeight: 18 },
  actionState: { fontSize: fontSize.sm, color: colors.inkFaint, fontWeight: '600' },
  danger: { color: colors.danger },
  blockRow: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  pressed: { opacity: 0.7 },
  // A wrapping grid rather than a fixed column count: percentage widths would
  // have to be recomputed against the gap, and a flexible tile size means the
  // last row of two photos doesn't stretch into two half-screen slabs.
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  tile: { width: 104, height: 104 },
  tileImage: {
    width: '100%',
    height: '100%',
    borderRadius: radius.md,
    backgroundColor: colors.line,
  },
});
