/**
 * The "living line" as a scrolling list — shared by the feed and a profile.
 *
 * Both screens render the same thing: a reverse-chronological run of posts with
 * a day divider wherever the calendar day changes, all hanging off one unbroken
 * spine. The only differences are what sits *above* the posts (the feed's
 * compose box; a profile's header/editor) and how paging is driven — so those
 * are props, and the row rendering + day-divider geometry live here, in one
 * place.
 *
 * **Why one component rather than two lists.** The spine only looks continuous
 * if every row agrees exactly where the line is (`SPINE_COLUMN`) and the day
 * dividers indent to match the post content column. When the feed owned that
 * inline, a profile list would have had to re-derive the same constants and
 * would drift the first time either changed — the exact hazard the C1 layout
 * note calls out. Sharing the renderer makes drift impossible.
 *
 * The list is deliberately *dumb about data*: it takes already-built `rows`
 * (`toRows`), never a raw post array, so the reverse-chronological order the
 * server guarantees is preserved by whoever built the rows and never re-touched
 * here.
 */

import { forwardRef } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  View,
  type FlatListProps,
} from 'react-native';

import { EventTimelineEntry } from './events/EventTimelineEntry';
import { PostCard } from './PostCard';
import { SPINE_COLUMN, Spine } from './timeline';
import type { FeedRow } from '@/feed';
import { colors, fontSize, spacing } from '@/theme';

type Props = {
  rows: FeedRow[];
  /** Scrolls away with the list — the compose box, or a profile header. */
  ListHeaderComponent?: FlatListProps<FeedRow>['ListHeaderComponent'];
  ListEmptyComponent?: FlatListProps<FeedRow>['ListEmptyComponent'];
  ListFooterComponent?: FlatListProps<FeedRow>['ListFooterComponent'];
  refreshControl?: FlatListProps<FeedRow>['refreshControl'];
  onEndReached?: () => void;
  contentContainerStyle?: FlatListProps<FeedRow>['contentContainerStyle'];
  keyboardShouldPersistTaps?: FlatListProps<FeedRow>['keyboardShouldPersistTaps'];
};

function renderRow({ item }: { item: FeedRow }) {
  if (item.kind === 'day') {
    // The divider carries its own spine segment: without one the line visibly
    // breaks at every change of day.
    return (
      <View style={styles.day}>
        <Spine />
        <Text style={styles.dayLabel}>{item.label}</Text>
        {item.sub ? <Text style={styles.daySub}>{item.sub}</Text> : null}
        {/* A hairline finishing the row, kept inside the content column so it
            separates the days without cutting across the spine. */}
        <View style={styles.dayRule} />
      </View>
    );
  }
  // A past event fallen into a group timeline as a recap (see toGroupRows).
  if (item.kind === 'event') {
    return <EventTimelineEntry event={item.event} variant="past" />;
  }
  return <PostCard post={item.post} />;
}

/**
 * `forwardRef` so the feed can keep its handle on the list (it scrolls a new
 * post into view). A profile has no such need, but the ref is harmless there.
 */
export const TimelineList = forwardRef<FlatList<FeedRow>, Props>(
  function TimelineList(
    {
      rows,
      ListHeaderComponent,
      ListEmptyComponent,
      ListFooterComponent,
      refreshControl,
      onEndReached,
      contentContainerStyle,
      // `handled` by default, not the FlatList default of `never`: any header
      // that carries an input *and* a button (the compose box's Post, the
      // profile editor's Save/Cancel) otherwise loses the first tap while the
      // keyboard is up — the tap is spent dismissing the keyboard instead of
      // pressing the button, the classic "this form is broken" papercut. With
      // `handled` a child that handles the tap keeps it; the keyboard only
      // dismisses on a tap nothing else caught.
      keyboardShouldPersistTaps = 'handled',
    },
    ref
  ) {
    return (
      <FlatList
        ref={ref}
        data={rows}
        keyExtractor={(row) => row.key}
        renderItem={renderRow}
        contentContainerStyle={[styles.list, contentContainerStyle]}
        ListHeaderComponent={ListHeaderComponent}
        ListEmptyComponent={ListEmptyComponent}
        ListFooterComponent={ListFooterComponent}
        refreshControl={refreshControl}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.4}
        keyboardShouldPersistTaps={keyboardShouldPersistTaps}
      />
    );
  }
);

const styles = StyleSheet.create({
  list: { paddingTop: spacing.sm, flexGrow: 1 },
  day: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.sm,
    // Indented to sit in the content column rather than cutting across the
    // spine. Derived from the shared geometry so it can't drift out of step.
    paddingLeft: SPINE_COLUMN + spacing.sm,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
  },
  dayLabel: { fontSize: fontSize.sm, fontWeight: '700', color: colors.inkSoft },
  daySub: { fontSize: 11, color: colors.inkFaint },
  dayRule: {
    flex: 1,
    height: 1,
    marginLeft: spacing.sm,
    marginRight: spacing.md,
    backgroundColor: colors.line,
  },
});
