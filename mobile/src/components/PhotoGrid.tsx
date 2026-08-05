/**
 * The photo grid a post and an event album both render, lifted out of
 * `PostCard` so the two can't drift. It is *navigation* — a compact index of
 * what's there — and deliberately not where a photo gets looked at; that's
 * `PhotoLightbox`'s job.
 *
 * Two rules, both because a card carrying its photos full-width turns one entry
 * into screens of scrolling and buries the rest of the timeline:
 *
 *   - **One photo keeps its natural shape**, with the height reserved from the
 *     dimensions the API sends so the feed doesn't reflow as it loads in.
 *   - **Several go into a two-column square grid**, so an entry costs a
 *     predictable, bounded amount of the timeline however many photos it has.
 *
 * `max` caps how many tiles are drawn and `total` is how many photos actually
 * exist. They're two numbers because an event's album is added to over the life
 * of the event and can be bigger than the payload that carried it — the last
 * tile then takes a "+N" overlay. A post passes neither (it's capped at ten and
 * always sends them all), so it gets the old behaviour with no branch.
 *
 * ⚠️ **Render this outside whatever `Pressable` wraps the card**, as `PostCard`
 * and `EventTimelineEntry` both do. Nesting it makes "did I open the post or
 * the photo?" a matter of touch-responder luck.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AuthedImage } from './AuthedImage';
import type { LightboxPhoto } from './PhotoLightbox';
import { colors, fontSize, radius, spacing } from '@/theme';

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

export function PhotoGrid({
  images,
  onOpen,
  max,
  total,
  label = 'photo',
  attribution,
}: {
  images: LightboxPhoto[];
  onOpen: (index: number) => void;
  max?: number;
  total?: number;
  /** What one tile is called in the accessibility label ("photo", "event photo"). */
  label?: string;
  /**
   * Trailing " from <name>" on the label. Kept separate from `label` so the
   * position stays where a screen reader expects it — "photo 1 of 5 from
   * Alice", never "photo from Alice 1 of 5". A post names its author (one
   * author, stated once above the grid); an album doesn't, since every tile
   * could be someone different and the viewer says who when you open one.
   */
  attribution?: string;
}) {
  if (!images?.length) return null;

  const shown = max ? images.slice(0, max) : images;
  const count = total ?? images.length;
  // How many the grid isn't drawing. Counted against the whole album rather
  // than the slice, so it stays right when the payload carries fewer than `max`.
  const extra = count - shown.length;
  const single = shown.length === 1 && extra === 0;

  return (
    <View style={[styles.grid, !single && styles.gridMultiple]}>
      {shown.map((image, index) => {
        const showOverlay = extra > 0 && index === shown.length - 1;
        return (
          <Pressable
            key={image.id}
            style={single ? styles.cellSingle : styles.cellMultiple}
            onPress={() => onOpen(index)}
            accessibilityRole="button"
            accessibilityLabel={
              showOverlay
                ? `View all ${count} photos`
                : `View ${label} ${index + 1} of ${count}${attribution ?? ''}`
            }
          >
            <AuthedImage
              uri={image.thumbnail}
              style={[
                styles.photo,
                single
                  ? {
                      aspectRatio:
                        image.width && image.height ? image.width / image.height : 1,
                    }
                  : styles.photoGrid,
              ]}
              contentFit="cover"
              transition={150}
            />
            {showOverlay ? (
              // Decorative: the Pressable's label already says "view all N
              // photos", so announcing the number twice would just be noise.
              <View style={styles.overlay} pointerEvents="none">
                <Text style={styles.overlayText}>+{extra}</Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
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
  overlay: {
    // Inset by the cell's own padding so the scrim covers the photo, not the
    // gutter around it.
    position: 'absolute',
    top: 0,
    bottom: PHOTO_GUTTER,
    left: PHOTO_GUTTER / 2,
    right: PHOTO_GUTTER / 2,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  overlayText: {
    color: '#fff',
    fontSize: fontSize.lg,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
});
