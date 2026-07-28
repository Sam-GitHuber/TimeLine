/**
 * The two rules that break a transcript into readable stretches (Phase 9b M5).
 *
 * **The day separator** answers the question a clock time on a bubble can't:
 * *which* 14:32. It's the same idea as the feed's day divider and deliberately
 * not the same object — the feed's runs along the timeline spine and indents to
 * the content column, because there the line is the point. A chat has no spine,
 * so this is the conventional centred label with a hairline either side, which
 * is what a transcript wants: something that separates without claiming to be
 * part of the conversation.
 *
 * **The unread divider** is the more useful of the two and the one people
 * actually navigate by: it marks where you stopped reading, so a thread you've
 * been away from opens *there* rather than at the bottom with no idea how far
 * back to scroll. Accented, because unlike the day label it's about you.
 *
 * Both are rendered inside an inverted list, so they arrive already flipped by
 * the list itself and need no special handling here.
 */

import { StyleSheet, Text, View } from 'react-native';

import { colors, fontSize, radius, spacing } from '@/theme';

export function DaySeparator({ label }: { label: string }) {
  return (
    // One accessible label for the row: read out as "Tuesday" rather than as
    // three separate elements with two of them empty.
    <View style={styles.day} accessibilityRole="header" accessible>
      <View style={styles.rule} />
      <Text style={styles.dayLabel}>{label}</Text>
      <View style={styles.rule} />
    </View>
  );
}

export function UnreadDivider({ count }: { count: number }) {
  const label = count === 1 ? '1 unread message' : `${count} unread messages`;
  return (
    <View style={styles.unread} accessibilityRole="header" accessible>
      <View style={styles.unreadRule} />
      <Text style={styles.unreadLabel}>{label}</Text>
      <View style={styles.unreadRule} />
    </View>
  );
}

const styles = StyleSheet.create({
  day: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
  },
  rule: { flex: 1, height: 1, backgroundColor: colors.line },
  dayLabel: {
    fontSize: 11,
    fontWeight: '700',
    // Small caps by way of letter-spacing: at 11px the label has to read as a
    // marker rather than as somebody's very short message.
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: colors.inkFaint,
  },
  unread: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  unreadRule: { flex: 1, height: 1, backgroundColor: colors.accent, opacity: 0.4 },
  unreadLabel: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: colors.accentTint,
    fontSize: fontSize.sm - 1,
    fontWeight: '700',
    color: colors.accentDeep,
  },
});
