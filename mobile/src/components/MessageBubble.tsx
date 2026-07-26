/**
 * One message row in a thread. Ported from the web's `MessageBubble`, restyled
 * native and with the touch affordances a phone needs.
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
 * **Long-press opens the action menu** (Phase 9b M1) — Copy/Edit/Delete on your
 * own, Copy/Report on someone else's. This replaced a long-press that went
 * straight to a delete confirm: a gesture that only ever deletes is a trap, and
 * there was nowhere to put edit. The bubble measures its own screen rect and
 * hands it up, because the menu anchors itself under the bubble you actually
 * pressed (see `MessageActionMenu`). A deleted message's tombstone has no menu —
 * there's nothing left to act on.
 */

import { useRef } from 'react';
import * as Haptics from 'expo-haptics';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from './Avatar';
import type { BubbleAnchor } from './MessageActionMenu';
import { measureInWindow } from '@/measure';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { Message } from '@/types';
import { formatRelativeTime } from '@/utils';

/**
 * The bubble itself — background, text, timestamp — with no positioning of its
 * own. Split out from `MessageBubble` so the action menu can redraw the pressed
 * bubble at its measured position and get *the real thing*, not a lookalike that
 * drifts the first time this styling changes. It deliberately carries no
 * `maxWidth`: the wrapper owns that, so a copy rendered into a fixed-width slot
 * fills it exactly.
 */
export function BubbleBody({ message, mine }: { message: Message; mine: boolean }) {
  return (
    <View style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
      <Text style={[styles.text, mine ? styles.mineText : styles.theirsText]}>
        {message.text}
      </Text>
      <Text style={[styles.time, mine ? styles.mineTime : styles.theirsTime]}>
        {formatRelativeTime(message.created_at)}
        {/* An edit is disclosed, never silent: a thread is a shared record, and
            quietly changing what someone already read would make it worthless
            as one. */}
        {message.is_edited ? ' · Edited' : ''}
      </Text>
    </View>
  );
}

export function MessageBubble({
  message,
  mine,
  showSender,
  onLongPress,
}: {
  message: Message;
  mine: boolean;
  showSender: boolean;
  /** Opens the action menu, anchored to this bubble's rect on screen. */
  onLongPress: (anchor: BubbleAnchor) => void;
}) {
  const bubbleRef = useRef<View>(null);

  function handleLongPress() {
    // A light tap under the finger is most of what makes the gesture feel
    // deliberate rather than accidental. Fire and forget — a phone without a
    // taptic engine simply resolves it.
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    // Measure first, open second: the menu positions itself from this rect, so
    // opening before it lands would put the menu somewhere and then move it.
    measureInWindow(bubbleRef.current, onLongPress);
  }

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
            ref={bubbleRef}
            onLongPress={handleLongPress}
            delayLongPress={350}
            accessibilityRole="text"
            // The label lets the menu be opened by assistive tech and driven in
            // tests, since a long-press isn't otherwise discoverable.
            accessibilityLabel={
              mine
                ? `Your message: ${message.text}`
                : `Message from ${message.sender.display_name}: ${message.text}`
            }
            accessibilityHint="Press and hold for message actions"
            style={styles.bubbleWrap}
          >
            <BubbleBody message={message} mine={mine} />
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
  bubbleWrap: { maxWidth: '80%' },
  bubble: {
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
