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

import { useMutation } from "@tanstack/react-query";
import { useRef, useState, type ReactNode } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";

import { api } from "@/api";
import { ReactionTray, type Anchor } from "./ReactionTray";
import { ReactorsSheet } from "./ReactorsSheet";
import { colors, fontSize, radius, spacing } from "@/theme";
import type { Reaction } from "@/types";

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
  trailing,
}: {
  postId?: number;
  commentId?: number;
  reactions: Reaction[] | undefined;
  /**
   * Extra footer content — the post's "N comments" link.
   *
   * **Placed here rather than by the caller because the placement depends on
   * live state this component owns.** With no reactions the row is just the `+`
   * button, so a lone link below it wastes a whole line and reads as orphaned;
   * it goes inline instead. Once there are chips the row is busy enough that
   * sharing it crowds both, so the link drops to its own line.
   *
   * The caller can't make that call: it only has the *server's* reaction list,
   * so adding your first reaction would leave the link crammed alongside the new
   * chip until the next refetch.
   */
  trailing?: ReactNode;
}) {
  const incoming = reactions ?? NO_REACTIONS;
  const target = postId != null ? { postId } : { commentId };

  const [items, setItems] = useState<Reaction[]>(incoming);
  const [whoOpen, setWhoOpen] = useState(false);

  /**
   * Whether the tray is open, and where the `+` button sits on screen.
   *
   * The tray is drawn in a full-screen Modal (React Native has no portal), so it
   * needs the trigger's *window* coordinates to sit beside it — hence measuring
   * on press rather than tracking layout continuously.
   *
   * **Open and position are deliberately separate state.** Keying "is it open"
   * off the measurement would mean a tray that silently never appears whenever
   * `measureInWindow` doesn't call back — a dead button, and the hardest kind of
   * bug to reproduce. Opening first and refining the position on measurement
   * degrades to a sensibly-placed tray instead of no tray.
   */
  const addRef = useRef<View>(null);
  const [trayOpen, setTrayOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  function openTray() {
    setTrayOpen(true);
    addRef.current?.measureInWindow((x, y, width, height) => {
      // A zero-sized measurement means the view isn't laid out yet; keep
      // whatever we had rather than pinning the tray to the top-left corner.
      if (width || height) setAnchor({ x, y, width, height });
    });
  }

  function closeTray() {
    setTrayOpen(false);
  }

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
    onSuccess: (data) => setItems(data.reactions ?? []),
    // Reacting is a small, cheap gesture, so a failure needs to say so rather
    // than leave a tap looking like it worked. The server owns the rules that
    // can reject one (per-target cap, emoji validation), so its message is what
    // gets shown.
    onError: (error) =>
      Alert.alert(
        "Couldn’t react",
        error instanceof Error ? error.message : "Something went wrong.",
      ),
  });

  function react(emoji: string) {
    closeTray();
    toggle.mutate(emoji);
  }

  const reactedEmojis = new Set(
    items.filter((item) => item.reacted).map((item) => item.emoji),
  );

  // Empty row ⇒ the `+` has the line to itself, so the link may as well share it.
  const inlineTrailing = items.length === 0;

  return (
    <>
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
              item.reacted ? ", you reacted — tap to remove" : " — tap to react"
            }`}
            hitSlop={4}
          >
            <Text style={styles.chipEmoji}>{item.emoji}</Text>
            <Text style={styles.chipCount}>{item.count}</Text>
          </Pressable>
        ))}

        {/* The View wrapper carries the ref: `measureInWindow` needs a host view,
          and a Pressable's ref isn't one to measure reliably. */}
        <View ref={addRef} collapsable={false}>
          <Pressable
            onPress={openTray}
            style={({ pressed }) => [styles.add, pressed && styles.chipPressed]}
            accessibilityRole="button"
            accessibilityLabel="Add a reaction"
            hitSlop={6}
          >
            <Text style={styles.addText}>+</Text>
          </Pressable>
        </View>

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

        {inlineTrailing ? trailing : null}
      </View>

      {trailing && !inlineTrailing ? (
        <View style={styles.trailing}>{trailing}</View>
      ) : null}

      <ReactionTray
        visible={trayOpen}
        anchor={anchor}
        onPick={react}
        onClose={closeTray}
        reactedEmojis={reactedEmojis}
      />

      <ReactorsSheet
        visible={whoOpen}
        onClose={() => setWhoOpen(false)}
        {...target}
      />
    </>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
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
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.raised,
  },
  addText: { fontSize: fontSize.base, color: colors.inkFaint, lineHeight: 20 },
  who: { fontSize: fontSize.sm, color: colors.inkFaint },
  trailing: { marginTop: spacing.sm },
});
