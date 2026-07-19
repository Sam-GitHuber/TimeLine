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

/** Width of the clock-time rail, sized to fit "11:10" without wrapping. */
export const RAIL = 48;

/** The column the spine runs down, between the rail and the content. */
export const SPINE_COLUMN = 40;

/** Distance from a row's left edge to the centre of the line. */
export const SPINE_CENTRE = RAIL + SPINE_COLUMN / 2;

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
