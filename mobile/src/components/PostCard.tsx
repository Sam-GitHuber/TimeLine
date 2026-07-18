/**
 * One post in the feed.
 *
 * Follows the design system's "living line" idea (docs/design-system.md): posts
 * hang off a continuous vertical spine, with the poster's avatar as the bead
 * marking each one and the clock time promoted onto the rail — the product's one
 * promise, made visible.
 *
 * It is **not** a pixel copy of the web card. The plan calls for native-feeling
 * over identical, so this drops the web's hover affordances (meaningless on
 * touch) and leans on the system font.
 *
 * Read-only in Milestone C1: reactions render as counts but don't toggle yet,
 * and comments show a count without opening. Both become interactive with the
 * post-detail screen in C2.
 */

import { StyleSheet, Text, View } from 'react-native';

import { AuthedImage } from './AuthedImage';
import { Avatar } from './Avatar';
import { RAIL, SPINE_COLUMN, Spine } from './timeline';
import type { Post } from '@/types';
import { colors, fontSize, radius, spacing } from '@/theme';
import { formatClockTime } from '@/utils';

/**
 * The alignment band for a post's first line: clock time, avatar bead and author
 * name all share one horizontal centre line.
 *
 * These three sit in separate columns with different content, so nothing lines
 * them up automatically — and getting it wrong is very visible, because the eye
 * reads the bead and the name as a single unit. Rather than nudging magic
 * paddings until it looks right (which then drifts at a different text size),
 * every element is given an explicit box of exactly `BEAD` height and the same
 * top offset, so their centres coincide by construction.
 *
 * `BEAD_BORDER` is the surface-coloured halo that separates the bead from the
 * spine behind it; it sits outside the avatar, so the content column has to be
 * pushed down by that much to stay centred on the avatar itself.
 */
const BEAD = 24; // matches Avatar size="xs"
const BEAD_BORDER = 3;

export function PostCard({ post }: { post: Post }) {
  const { time, meridiem } = formatClockTime(post.created_at);

  return (
    <View style={styles.row}>
      {/* The rail: clock time, then the spine with the author's avatar as bead. */}
      <View style={styles.rail}>
        {/* numberOfLines guards the same failure the width does: never let the
            time break across lines, whatever the font scale. */}
        <Text style={styles.time} numberOfLines={1}>
          {time}
        </Text>
        <Text style={styles.meridiem} numberOfLines={1}>
          {meridiem}
        </Text>
      </View>

      <Spine />

      <View style={styles.spineColumn}>
        <View style={styles.bead}>
          <Avatar user={post.author} size="xs" />
        </View>
      </View>

      <View style={styles.card}>
        <View style={styles.header}>
          <Text style={styles.author} numberOfLines={1}>
            {post.author.display_name}
          </Text>
          {/* Silently altering content others have read is a trust problem, so
              the marker is not optional — see feed-and-posts.md. */}
          {post.edited_at ? <Text style={styles.edited}>· edited</Text> : null}
        </View>

        {post.group ? (
          <Text style={styles.group}>in {post.group.name}</Text>
        ) : null}

        {post.text ? <Text style={styles.text}>{post.text}</Text> : null}

        {post.images.map((image) => (
          <AuthedImage
            key={image.id}
            uri={image.thumbnail}
            style={[
              styles.photo,
              // Reserve the right height from the dimensions the API sends, so
              // the feed doesn't reflow as photos load in.
              { aspectRatio: image.width && image.height ? image.width / image.height : 1 },
            ]}
            contentFit="cover"
            transition={150}
            accessibilityLabel={`Photo from ${post.author.display_name}`}
          />
        ))}

        <View style={styles.footer}>
          {post.reactions.map((reaction) => (
            <View
              key={reaction.emoji}
              style={[styles.chip, reaction.reacted && styles.chipMine]}
            >
              <Text style={styles.chipEmoji}>{reaction.emoji}</Text>
              <Text style={styles.chipCount}>{reaction.count}</Text>
            </View>
          ))}
          {post.comment_count > 0 ? (
            <Text style={styles.comments}>
              {post.comment_count}{' '}
              {post.comment_count === 1 ? 'comment' : 'comments'}
              {post.new_comment_count > 0 ? (
                <Text style={styles.newComments}>
                  {' '}
                  · {post.new_comment_count} new
                </Text>
              ) : null}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', paddingRight: spacing.md },
  rail: {
    width: RAIL,
    alignItems: 'flex-end',
    // Offset by the bead's halo so the time's line box starts level with the
    // avatar rather than with the halo around it.
    paddingTop: BEAD_BORDER,
  },
  time: {
    fontSize: fontSize.sm,
    color: colors.inkSoft,
    fontVariant: ['tabular-nums'],
    // An explicit line box of exactly the bead's height: the time's centre then
    // lands on the bead's centre with no fudging.
    lineHeight: BEAD,
  },
  meridiem: { fontSize: 11, color: colors.inkFaint, lineHeight: 13 },
  spineColumn: { width: SPINE_COLUMN, alignItems: 'center' },
  bead: {
    // A surface-coloured halo separates the bead from the line behind it.
    borderWidth: BEAD_BORDER,
    borderColor: colors.surface,
    borderRadius: radius.pill,
  },
  card: {
    flex: 1,
    // Deliberately no background, border, or radius. A raised white card reads
    // as a separate object floating *above* the timeline; the design's whole
    // idea is that entries hang *off* the living line. Sitting the content
    // straight on the surface keeps the spine the thing holding the feed
    // together. Spacing and the day dividers do the separating instead.
    paddingTop: BEAD_BORDER,
    paddingBottom: spacing.lg,
    paddingLeft: spacing.xs,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  author: {
    fontSize: fontSize.base,
    fontWeight: '600',
    color: colors.ink,
    // Same explicit bead-height line box as the clock time — this is what makes
    // the name sit exactly level with the avatar.
    lineHeight: BEAD,
    flexShrink: 1,
  },
  edited: { fontSize: fontSize.sm, color: colors.inkFaint, lineHeight: BEAD },
  group: { fontSize: fontSize.sm, color: colors.inkFaint, marginTop: 2 },
  text: {
    fontSize: fontSize.base,
    color: colors.ink,
    lineHeight: 23,
    marginTop: spacing.sm,
  },
  photo: {
    width: '100%',
    borderRadius: radius.md,
    marginTop: spacing.sm,
    backgroundColor: colors.line,
  },
  footer: {
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
    // Raised (white) against the surface now that the post itself has no card —
    // the chips are the one thing here that should read as a pressable object.
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  chipMine: { backgroundColor: colors.accentTint, borderColor: colors.accent },
  chipEmoji: { fontSize: 13 },
  chipCount: { fontSize: fontSize.sm, color: colors.inkSoft },
  comments: { fontSize: fontSize.sm, color: colors.inkFaint },
  newComments: { color: colors.accent, fontWeight: '600' },
});
