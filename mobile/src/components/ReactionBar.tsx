/**
 * The reaction row under a post, comment or reply.
 *
 * Pass exactly one of `postId` / `commentId`, plus the target's `reactions`
 * summary as the server sent it.
 *
 * **Counts are pruned per viewer, server-side** — what's shown is already only
 * the reactions from people you may see, so two people can legitimately see
 * different counts on the same post (reactions.md). Nothing here filters or
 * aggregates; it renders what arrived.
 *
 * Tapping a chip toggles your own reaction. The toggle endpoint returns the
 * fresh summary, so a tap updates in place without refetching the feed.
 */

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { api, ApiError } from '@/api';
import { EmojiSheet } from './EmojiSheet';
import { ReactorsSheet } from './ReactorsSheet';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { Reaction } from '@/types';

/**
 * A stable empty array for the "no reactions" case.
 *
 * Without this, a target with no reactions would get a fresh `[]` on every
 * render, the identity check in the sync below would always fire, and the
 * component would re-render forever.
 */
const NO_REACTIONS: Reaction[] = [];

export function ReactionBar({
  postId,
  commentId,
  reactions,
}: {
  postId?: number;
  commentId?: number;
  reactions: Reaction[] | undefined;
}) {
  const incoming = reactions ?? NO_REACTIONS;
  const target = postId != null ? { postId } : { commentId };

  const [items, setItems] = useState<Reaction[]>(incoming);
  const [picking, setPicking] = useState(false);
  const [whoOpen, setWhoOpen] = useState(false);

  /**
   * Re-sync when the server's summary changes underneath us — a feed refetch, or
   * coming back to this post.
   *
   * This is the "adjust state during render" pattern rather than an effect: an
   * effect would render the stale list for a frame first. TanStack Query's
   * structural sharing keeps the `reactions` reference stable when nothing
   * actually changed, so this only fires on a genuine change and doesn't clobber
   * the result of an in-flight toggle on every render.
   */
  const [syncedFrom, setSyncedFrom] = useState(incoming);
  if (incoming !== syncedFrom) {
    setSyncedFrom(incoming);
    setItems(incoming);
  }

  const toggle = useMutation({
    mutationFn: (emoji: string) => api.toggleReaction({ ...target, emoji }),
    onSuccess: (data) => {
      setItems(data.reactions ?? []);
      setPicking(false);
    },
  });

  // Only surface a rejected *emoji* in the sheet — that's the case the person
  // can do something about (they typed something that isn't one). Any other
  // failure leaves the row as it was rather than shouting about it.
  const pickError =
    toggle.error instanceof ApiError && toggle.error.status === 400
      ? toggle.error.message
      : null;

  const reactedEmojis = new Set(
    items.filter((item) => item.reacted).map((item) => item.emoji)
  );

  return (
    <View style={styles.row}>
      {items.map((item) => (
        <Pressable
          key={item.emoji}
          onPress={() => toggle.mutate(item.emoji)}
          style={({ pressed }) => [
            styles.chip,
            item.reacted && styles.chipMine,
            pressed && styles.chipPressed,
          ]}
          accessibilityRole="button"
          accessibilityState={{ selected: item.reacted }}
          accessibilityLabel={`${item.emoji}, ${item.count}${
            item.reacted
              ? ', you reacted — tap to remove'
              : ' — tap to react'
          }`}
          hitSlop={4}
        >
          <Text style={styles.chipEmoji}>{item.emoji}</Text>
          <Text style={styles.chipCount}>{item.count}</Text>
        </Pressable>
      ))}

      <Pressable
        onPress={() => setPicking(true)}
        style={({ pressed }) => [styles.add, pressed && styles.chipPressed]}
        accessibilityRole="button"
        accessibilityLabel="Add a reaction"
        hitSlop={6}
      >
        <Text style={styles.addText}>+</Text>
      </Pressable>

      {items.length > 0 ? (
        <Pressable
          onPress={() => setWhoOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="See who reacted"
          hitSlop={6}
        >
          <Text style={styles.who}>Who reacted?</Text>
        </Pressable>
      ) : null}

      <EmojiSheet
        visible={picking}
        onPick={(emoji) => toggle.mutate(emoji)}
        onClose={() => {
          setPicking(false);
          toggle.reset();
        }}
        reactedEmojis={reactedEmojis}
        error={pickError}
      />

      <ReactorsSheet
        visible={whoOpen}
        onClose={() => setWhoOpen(false)}
        {...target}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    // Raised against the surface: with posts sitting straight on the ground
    // (no card), the chips are the one element that should read as pressable.
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  chipMine: { backgroundColor: colors.accentTint, borderColor: colors.accent },
  chipPressed: { opacity: 0.6 },
  chipEmoji: { fontSize: 13 },
  chipCount: { fontSize: fontSize.sm, color: colors.inkSoft },
  add: {
    width: 26,
    height: 26,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.raised,
  },
  addText: { fontSize: fontSize.base, color: colors.inkFaint, lineHeight: 20 },
  who: { fontSize: fontSize.sm, color: colors.inkFaint },
});
