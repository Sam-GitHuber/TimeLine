/**
 * One message row in a thread. Ported from the web's `MessageBubble`, restyled
 * native and with the delete affordance adapted to touch.
 *
 * Layout mirrors the web: your messages align right with the filled accent,
 * everyone else's align left in a raised bubble. A soft-deleted message leaves a
 * muted "Message deleted" tombstone in its original spot, so the thread never
 * silently reshuffles.
 *
 * **Group sender attribution.** In a *group* thread an incoming message shows its
 * sender's avatar + name on a line above the bubble — without it, three people's
 * left-aligned bubbles are indistinguishable. Only the *first* bubble of a
 * consecutive run from one sender is labelled (`showSender`, decided by the
 * caller), so a burst reads as one block. Three deliberate exclusions, all
 * handled by the caller passing `showSender={false}`: 1:1 threads (only one
 * person it could be), your own messages (right-alignment already says they're
 * yours), and a run's later bubbles.
 *
 * **Delete is a long-press**, not a hover button (a phone has no hover): pressing
 * and holding your own message asks the caller to confirm, via `onRequestDelete`.
 * A deleted message and anyone else's can't be long-pressed to delete.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from './Avatar';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { Message } from '@/types';
import { formatRelativeTime } from '@/utils';

export function MessageBubble({
  message,
  mine,
  showSender,
  onRequestDelete,
}: {
  message: Message;
  mine: boolean;
  showSender: boolean;
  /** Called on long-press of your own, non-deleted message. */
  onRequestDelete: () => void;
}) {
  const deletable = mine && !message.is_deleted;

  return (
    <View style={styles.row}>
      {showSender && (
        <View style={styles.senderLine}>
          <Avatar user={message.sender} size="xs" />
          <Text style={styles.senderName} numberOfLines={1}>
            {message.sender.display_name}
          </Text>
        </View>
      )}

      <View style={[styles.bubbleRow, mine ? styles.alignEnd : styles.alignStart]}>
        {message.is_deleted ? (
          <View style={styles.tombstone}>
            <Text style={styles.tombstoneText}>Message deleted</Text>
          </View>
        ) : (
          <Pressable
            onLongPress={deletable ? onRequestDelete : undefined}
            delayLongPress={350}
            accessibilityRole="text"
            // The label lets the delete path be driven in tests and read out to
            // assistive tech, since long-press isn't otherwise discoverable.
            accessibilityLabel={
              deletable ? `Your message: ${message.text}` : undefined
            }
            style={[styles.bubble, mine ? styles.mine : styles.theirs]}
          >
            <Text style={[styles.text, mine ? styles.mineText : styles.theirsText]}>
              {message.text}
            </Text>
            <Text style={[styles.time, mine ? styles.mineTime : styles.theirsTime]}>
              {formatRelativeTime(message.created_at)}
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { marginBottom: spacing.sm },
  senderLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
    marginBottom: spacing.xs,
  },
  senderName: {
    flexShrink: 1,
    fontSize: fontSize.sm - 1,
    fontWeight: '500',
    color: colors.inkSoft,
  },
  bubbleRow: { flexDirection: 'row' },
  alignEnd: { justifyContent: 'flex-end' },
  alignStart: { justifyContent: 'flex-start' },
  bubble: {
    maxWidth: '80%',
    paddingHorizontal: spacing.md - 2,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
  },
  mine: { backgroundColor: colors.accent },
  theirs: {
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.line,
  },
  text: { fontSize: fontSize.base - 1, lineHeight: 21 },
  mineText: { color: '#ffffff' },
  theirsText: { color: colors.ink },
  time: { marginTop: 2, fontSize: 11 },
  mineTime: { color: 'rgba(255,255,255,0.7)' },
  theirsTime: { color: colors.inkFaint },
  tombstone: {
    maxWidth: '80%',
    paddingHorizontal: spacing.md - 2,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
    backgroundColor: 'rgba(28,26,22,0.03)',
  },
  tombstoneText: {
    fontSize: fontSize.base - 1,
    fontStyle: 'italic',
    color: colors.inkFaint,
  },
});
