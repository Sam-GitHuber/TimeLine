/**
 * "Who reacted" — the visible reactor list, grouped by emoji.
 *
 * **Pruned per viewer, server-side — for a post or comment.** That list only ever
 * contains people you're connected with (plus yourself), so a reactor you don't
 * know is never named here; reactions can't surface a stranger second-hand. Two
 * people can therefore see different lists on the same post, which is correct
 * rather than a bug (reactions.md).
 *
 * A **message**'s reactors aren't pruned, because a chat's active participants
 * are a clique by construction — anyone who can see the message can already see
 * everyone who reacted, so everyone in a thread sees the same list. Nothing here
 * changes either way: the server decides and this renders what arrives.
 *
 * **Your own row can be tapped to take your reaction off**, when the caller
 * supplies `onRemoveReaction` — the message thread does. That's the standard
 * shape: the sheet is where you go to look at a reaction, so it's also where you
 * expect to be able to undo yours. Callers that don't pass it (the feed, whose
 * chips toggle on tap already) get the plain read-only list, unchanged.
 */

import { useQuery } from '@tanstack/react-query';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { api, type ReactionTarget } from '@/api';
import { Avatar } from './Avatar';
import { colors, fontSize, radius, spacing } from '@/theme';

/**
 * The cache key for one target's reactor list.
 *
 * Exported because **anything that toggles a reaction has to invalidate it**,
 * and this cache outlives the sheet: it's filled while the sheet is open and
 * kept after it unmounts, so the next open renders the old list first (there's
 * data, so `isLoading` is false) and only flips when the refetch lands. Worse
 * than the flicker, that stale list is *actionable* — a removed reaction still
 * showing "Tap to remove" would call the toggle again and silently put it back.
 * One helper so the key can't be spelled two ways and drift.
 */
export function reactorsQueryKey({
  postId,
  commentId,
  messageId,
  eventId,
}: ReactionTarget) {
  return [
    'reactors',
    postId ?? null,
    commentId ?? null,
    messageId ?? null,
    eventId ?? null,
  ];
}

export function ReactorsSheet({
  visible,
  onClose,
  postId,
  commentId,
  messageId,
  eventId,
  meId,
  onRemoveReaction,
}: {
  visible: boolean;
  onClose: () => void;
  postId?: number;
  commentId?: number;
  messageId?: number;
  eventId?: number;
  /**
   * Which row is yours, so it can offer to remove your reaction. A prop rather
   * than a `useAuth()` call on purpose: this sheet is otherwise a pure renderer
   * of what the server sent, and reaching for context here would make every
   * caller — the feed's `ReactionBar` included — depend on an auth provider for
   * a feature only the message thread uses.
   */
  meId?: number;
  /**
   * Take your own reaction off from inside the sheet. Omitted when the viewer
   * can't write to the target (a thread you've been disconnected from), which
   * leaves the list readable but not actionable.
   */
  onRemoveReaction?: (emoji: string) => void;
}) {
  const target =
    postId != null
      ? { postId }
      : commentId != null
        ? { commentId }
        : messageId != null
          ? { messageId }
          : { eventId };

  const { data, isLoading, error } = useQuery({
    queryKey: reactorsQueryKey({ postId, commentId, messageId, eventId }),
    queryFn: () => api.getReactors(target),
    // Only fetch once the sheet is actually open — this is a per-target request
    // and the feed can hold dozens of targets at a time.
    enabled: visible,
  });

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        style={styles.scrim}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close"
      >
        <Pressable style={styles.sheet} onPress={() => {}}>
          <Text style={styles.title}>Who reacted</Text>

          {isLoading ? (
            <ActivityIndicator color={colors.accent} style={styles.spinner} />
          ) : error ? (
            <Text style={styles.error}>
              {error instanceof Error ? error.message : 'Couldn’t load that.'}
            </Text>
          ) : (
            <ScrollView style={styles.list}>
              {data?.map((group) => (
                <View key={group.emoji} style={styles.group}>
                  <Text style={styles.groupEmoji}>
                    {group.emoji} {group.count}
                  </Text>
                  {group.users.map((user) => {
                    const removable =
                      !!onRemoveReaction && meId != null && user.id === meId;
                    return (
                      <Pressable
                        key={user.id}
                        // A plain row when it isn't yours: `onPress` is
                        // undefined, so the whole thing is inert rather than
                        // pressable-looking and doing nothing.
                        onPress={
                          removable
                            ? () => {
                                // Close first — the reaction is gone, and
                                // leaving the sheet up over a list that's about
                                // to refetch just shows the old count for a beat.
                                onClose();
                                onRemoveReaction(group.emoji);
                              }
                            : undefined
                        }
                        accessibilityRole={removable ? 'button' : 'text'}
                        accessibilityLabel={
                          removable
                            ? `Remove your ${group.emoji} reaction`
                            : user.display_name
                        }
                        style={({ pressed }) => [
                          styles.person,
                          removable && pressed && styles.personPressed,
                        ]}
                      >
                        <Avatar user={user} size="xs" />
                        <Text style={styles.name} numberOfLines={1}>
                          {user.display_name}
                        </Text>
                        {removable ? (
                          <Text style={styles.remove}>Tap to remove</Text>
                        ) : null}
                      </Pressable>
                    );
                  })}
                </View>
              ))}
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(28, 26, 22, 0.35)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.raised,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
    maxHeight: '70%',
    gap: spacing.md,
  },
  title: { fontSize: fontSize.base, fontWeight: '700', color: colors.ink },
  spinner: { marginVertical: spacing.lg },
  error: { fontSize: fontSize.sm, color: colors.danger },
  list: { flexGrow: 0 },
  group: { marginBottom: spacing.md, gap: spacing.sm },
  groupEmoji: { fontSize: fontSize.base, color: colors.inkSoft },
  person: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  personPressed: { backgroundColor: colors.accentTint },
  name: { fontSize: fontSize.sm, color: colors.ink, flexShrink: 1 },
  // Pushed to the trailing edge: it's a hint about the row, not part of the name.
  remove: {
    marginLeft: 'auto',
    fontSize: fontSize.sm - 1,
    color: colors.inkFaint,
  },
});
