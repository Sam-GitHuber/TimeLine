/**
 * One post in the feed, and on the permalink screen.
 *
 * Follows the design system's "living line" idea (docs/design-system.md): posts
 * hang off a continuous vertical spine, with the poster's avatar as the bead
 * marking each one, and the clock time leading the entry — the product's one
 * promise, made visible.
 *
 * It is **not** a pixel copy of the web card, and the layout deliberately
 * diverges from it. The web puts the clock time in its own rail to the *left* of
 * the spine; here the time sits inline beside the author's name so the spine can
 * hug the screen edge. On a 390pt phone that rail cost ~48pt of every line of
 * every post, which is a lot of a caption — see `timeline.tsx`.
 *
 * The plan calls for native-feeling over identical, so this also drops the web's
 * hover affordances (meaningless on touch) and leans on the system font.
 */

import { router } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AuthedImage } from './AuthedImage';
import { Avatar } from './Avatar';
import { PhotoLightbox } from './PhotoLightbox';
import { PostMenu } from './PostMenu';
import { ReactionBar } from './ReactionBar';
import { SPINE_COLUMN, Spine } from './timeline';
import type { Post } from '@/types';
import { colors, fontSize, radius, spacing } from '@/theme';
import { formatClockTime } from '@/utils';

/**
 * The post's content, made tappable only when there's somewhere to go.
 *
 * A `Pressable` that does nothing still swallows touches and reports itself as a
 * button to a screen reader, so the permalink screen — where tapping the post
 * would just reopen the screen you're on — gets a plain `View` instead.
 */
function Body({ onPress, children }: { onPress?: () => void; children: ReactNode }) {
  if (!onPress) return <>{children}</>;
  return (
    <Pressable onPress={onPress} accessibilityRole="button">
      {children}
    </Pressable>
  );
}

/**
 * The alignment band for a post's first line: the avatar bead on the spine, and
 * beside it the clock time and the author's name.
 *
 * The bead sits in its own column and the text in another, so nothing lines them
 * up automatically — and getting it wrong is very visible, because the eye reads
 * the bead and the name as a single unit. Rather than nudging magic paddings
 * until it looks right (which then drifts at a different text size), each is
 * given an explicit box of exactly `BEAD` height, so their centres coincide by
 * construction.
 *
 * `BEAD_BORDER` is the surface-coloured halo that separates the bead from the
 * spine behind it; it sits outside the avatar, so the content column has to be
 * pushed down by that much to stay centred on the avatar itself.
 */
const BEAD = 24; // matches Avatar size="xs"
const BEAD_BORDER = 3;

/**
 * The gutter between photos in a multi-photo grid.
 *
 * Applied as padding *inside* each cell and cancelled by a negative margin on
 * the grid, rather than as a `gap`: two 50%-wide cells plus a gap add up to more
 * than the row, so a gap would push the second column off the screen. This is
 * the standard percentage-grid gutter, and it keeps the outer edges flush with
 * the rest of the card.
 */
const PHOTO_GUTTER = spacing.sm;

export function PostCard({
  post,
  /** False on the permalink screen, where there's nowhere further to go. */
  interactive = true,
}: {
  post: Post;
  interactive?: boolean;
}) {
  const { time, meridiem } = formatClockTime(post.created_at);
  /** Which photo the full-screen viewer is open on, or `null` when it's closed. */
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  /** Several photos get the compact square grid; a lone one keeps its shape. */
  const multiple = post.images.length > 1;

  const openPost = () => router.push(`/post/${post.id}`);
  // The author's bead and name go to their profile — a separate destination
  // from the post body, and reachable even on the permalink where the body
  // itself is inert. This is the app's main way into `/u/[id]` (C4).
  const openAuthor = () => router.push(`/u/${post.author.id}`);

  return (
    <View style={styles.row}>
      <Spine />

      <View style={styles.spineColumn}>
        <Pressable
          onPress={openAuthor}
          accessibilityRole="button"
          accessibilityLabel={`${post.author.display_name}’s profile`}
          hitSlop={6}
          style={styles.bead}
        >
          <Avatar user={post.author} size="xs" />
        </Pressable>
      </View>

      <View style={styles.card}>
        {/* Only the post's *content* opens the permalink, not the whole row.
            Keeping the reaction chips outside this Pressable means a tap meant
            for a chip can never be swallowed by the card behind it. */}
        <Body onPress={interactive ? openPost : undefined}>
          <View style={styles.header}>
            {/* The time leads the line — it's still the voice of the timeline,
                just inline now rather than out in its own rail.
                `numberOfLines` so it can never wrap, whatever the font scale. */}
            <Text style={styles.time} numberOfLines={1}>
              {time}
              <Text style={styles.meridiem}>{meridiem}</Text>
            </Text>
            {/* `onPress` on the Text itself, not a wrapping Pressable, so it
                stays inline and keeps its shrink/line-height without disturbing
                the band's alignment. It wins the touch over the body behind it,
                so tapping the name opens the profile, not the post. */}
            <Text
              style={styles.author}
              numberOfLines={1}
              onPress={openAuthor}
              accessibilityRole="button"
            >
              {post.author.display_name}
            </Text>
            {/* Silently altering content others have read is a trust problem, so
                the marker is not optional — see feed-and-posts.md. */}
            {post.edited_at ? <Text style={styles.edited}>· edited</Text> : null}
            {/* The ⋯ menu (Delete own / Report others). A nested Pressable, so it
                wins its own touch over the body behind it, and pushes itself to
                the far right via `marginLeft: auto`. */}
            <PostMenu postId={post.id} authorId={post.author.id} />
          </View>

          {post.group ? (
            <Text style={styles.group}>in {post.group.name}</Text>
          ) : null}

          {post.text ? <Text style={styles.text}>{post.text}</Text> : null}
        </Body>

        {/* Photos sit *outside* the body Pressable, for the same reason the
            reaction chips do: tapping a photo opens the viewer, and nesting it
            inside the card's own Pressable makes which one wins a matter of
            touch-responder luck. Out here the two targets can't collide. */}
        {post.images.length > 0 ? (
          <View style={[styles.grid, multiple && styles.gridMultiple]}>
            {post.images.map((image, index) => (
              <Pressable
                key={image.id}
                style={multiple ? styles.cellMultiple : styles.cellSingle}
                onPress={() => setLightboxIndex(index)}
                accessibilityRole="button"
                accessibilityLabel={`View photo ${index + 1} of ${post.images.length} from ${post.author.display_name}`}
              >
                <AuthedImage
                  uri={image.thumbnail}
                  style={[
                    styles.photo,
                    multiple
                      ? // Several photos share a uniform square grid, so a post
                        // with ten of them costs a predictable, bounded amount
                        // of the timeline instead of screens of scrolling.
                        styles.photoGrid
                      : // A lone photo keeps its natural shape, with the height
                        // reserved from the dimensions the API sends so the feed
                        // doesn't reflow as it loads in.
                        {
                          aspectRatio:
                            image.width && image.height ? image.width / image.height : 1,
                        },
                  ]}
                  contentFit="cover"
                  transition={150}
                />
              </Pressable>
            ))}
          </View>
        ) : null}

        {lightboxIndex !== null ? (
          <PhotoLightbox
            images={post.images}
            initialIndex={lightboxIndex}
            onClose={() => setLightboxIndex(null)}
          />
        ) : null}

        {/* The comments link is handed to `ReactionBar` rather than rendered
            here, because where it belongs depends on whether there are any
            reaction chips — and only `ReactionBar` knows that live. On the
            permalink there's no link at all: the thread is already below it. */}
        <ReactionBar
          postId={post.id}
          reactions={post.reactions}
          trailing={
            interactive ? (
              <Pressable
                onPress={openPost}
                accessibilityRole="button"
                accessibilityLabel={
                  post.comment_count > 0
                    ? `${post.comment_count} comments, open the thread`
                    : 'Add a comment'
                }
                hitSlop={6}
              >
                <Text style={styles.comments}>
                  {post.comment_count > 0
                    ? `${post.comment_count} ${post.comment_count === 1 ? 'comment' : 'comments'}`
                    : 'Comment'}
                  {post.new_comment_count > 0 ? (
                    <Text style={styles.newComments}>
                      {' '}
                      · {post.new_comment_count} new
                    </Text>
                  ) : null}
                </Text>
              </Pressable>
            ) : null
          }
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', paddingRight: spacing.md },
  time: {
    fontSize: fontSize.sm,
    color: colors.inkSoft,
    // Tabular figures so the times down a column don't shuffle left and right
    // as the digits change — the one place that jitter would be obvious.
    fontVariant: ['tabular-nums'],
    // An explicit line box of exactly the bead's height: the text's centre then
    // lands on the bead's centre with no fudging.
    lineHeight: BEAD,
  },
  meridiem: { fontSize: 11, color: colors.inkFaint },
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
    // A little air off the spine column, not a full indent — the point of
    // moving the line to the edge was to give this column the width back.
    paddingLeft: spacing.sm,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
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
  grid: { marginTop: spacing.sm },
  gridMultiple: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    // Cancels the gutter each cell pads itself with, so the outer photos stay
    // flush with the text above them instead of being inset by half a gutter —
    // and the last row doesn't leave a stray gutter above the reaction bar.
    marginHorizontal: -PHOTO_GUTTER / 2,
    marginBottom: -PHOTO_GUTTER,
  },
  cellSingle: { width: '100%' },
  cellMultiple: {
    // Exactly two columns — the whole point of the grid. An odd last photo
    // therefore sits half-width rather than stretching back out to full.
    width: '50%',
    paddingHorizontal: PHOTO_GUTTER / 2,
    paddingBottom: PHOTO_GUTTER,
  },
  photo: {
    width: '100%',
    borderRadius: radius.md,
    backgroundColor: colors.line,
  },
  photoGrid: { aspectRatio: 1 },
  // The reaction chips' styles moved to `ReactionBar` with the rest of them —
  // one owner, so the feed and the comment thread can't drift apart.
  // No margin of its own: inline it must sit on the reaction row's centre line,
  // and on its own line `ReactionBar`'s `trailing` wrapper provides the spacing.
  comments: { fontSize: fontSize.sm, color: colors.inkFaint },
  newComments: { color: colors.accent, fontWeight: '600' },
});
