/**
 * The geometry of the "living line", in one place.
 *
 * Every row of the feed — the compose box, day dividers, and each post — draws
 * its own segment of the spine, because a `FlatList` virtualises rows and a
 * single line drawn behind the whole list would scroll out of step with them.
 *
 * That only looks like one continuous line if every row agrees *exactly* where
 * it is and every segment butts against its neighbours. So the constants live
 * here and the segment is a shared component: a row that forgets to draw one
 * leaves a visible gap in the middle of the feed, which is precisely what
 * happened when day dividers had no segment of their own.
 */

import { StyleSheet, View } from 'react-native';

import { colors } from '@/theme';

/**
 * The column the spine runs down, at the very left of the screen.
 *
 * **The clock time used to sit in a 48px rail to the left of this**, which put
 * the line a third of the way into a phone screen and left every post squeezed
 * into what remained. The time now sits inline at the head of each entry, beside
 * the author's name, so the spine can hug the edge and the content gets the
 * width back — about 48px of a 390px screen, which is a lot of a photo caption.
 *
 * Wide enough for the avatar bead (24) plus its halo (3 each side) plus a little
 * air, so the bead never touches the screen edge.
 */
export const SPINE_COLUMN = 36;

/** Distance from a row's left edge to the centre of the line. */
export const SPINE_CENTRE = SPINE_COLUMN / 2;

const SPINE_WIDTH = 2;

/**
 * One row's segment of the spine.
 *
 * Absolutely positioned and stretched over the row's full height, so segments
 * meet exactly at row boundaries with no seam and no overlap.
 */
export function Spine({ top = 0 }: { top?: number }) {
  return <View style={[styles.spine, { top }]} pointerEvents="none" />;
}

const styles = StyleSheet.create({
  spine: {
    position: 'absolute',
    left: SPINE_CENTRE - SPINE_WIDTH / 2,
    bottom: 0,
    width: SPINE_WIDTH,
    backgroundColor: colors.spine,
  },
});
