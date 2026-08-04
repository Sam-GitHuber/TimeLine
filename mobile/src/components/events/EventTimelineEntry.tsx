/**
 * An event as an entry *on* the timeline spine — the same shape as a `PostCard`
 * (a bead on the line, the time leading the entry, the content hanging off it),
 * so an event reads as part of the one continuous line rather than a boxed card
 * wedged into it. Used where an event threads the spine among posts.
 *
 * `variant` decides the voice:
 *   - `"past"` (below the now boundary, among the posts) — a quiet **recap**: the
 *     event's clock time leads the entry like a post's does (the day divider
 *     already carries the date), and the body is the title, where it was, and the
 *     turnout. This is what E3b weaves into the group timeline.
 *   - `"future"` (above the now boundary) — the whole date leads in accent,
 *     because there are no day dividers up there to carry it, and the body keeps
 *     the live chips. Available for parity; E3b's group page renders the upcoming
 *     region as `EventCard`s in the header instead (see the mobile note in
 *     events.md / the phase plan), so `"past"` is the variant in use.
 *
 * **The time is inline, not on a rail — deliberately, and unlike the web.** The
 * web puts an event's date/time in its own column to the *left* of the spine,
 * which is where this file's first port put it too: a stacked mono `Rail` inside
 * `SPINE_COLUMN`. That column is 36pt wide and has the 2pt spine drawn down the
 * middle of it, so the time was painted straight over the line and wrapped
 * inside a box narrower than it needed. `PostCard` had already faced this and
 * moved the clock time inline beside the author's name so the spine could hug
 * the screen edge (see `timeline.tsx`) — an event on the same line has to make
 * the same move, or the two entry kinds disagree about where the voice of time
 * lives on a phone.
 *
 * So the geometry below follows `PostCard` — bead alone in the spine column, an
 * alignment band of exactly `BEAD` height carrying the time and the organiser —
 * and the line never breaks between a post and an event. **Matching it in
 * spirit isn't enough: the two times have to be the same width**, since they
 * share a column and the names that follow them start where they end. Which is
 * why the band takes no `fonts.mono` (see `styles.when`) and why
 * `formatEventTimeParts` pads its minutes the way `formatClockTime` does.
 */

import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '../Avatar';
import { ReactionBar } from '../ReactionBar';
import { SPINE_COLUMN, Spine } from '../timeline';
import { DimensionChips } from './DimensionChips';
import {
  formatEventDate,
  formatEventTime,
  formatEventTimeParts,
} from '@/eventFormat';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { Event } from '@/types';

const BEAD = 24; // matches Avatar size="xs" and PostCard
const BEAD_BORDER = 3;

export function EventTimelineEntry({
  event,
  variant = 'future',
}: {
  event: Event;
  variant?: 'future' | 'past';
}) {
  const past = variant === 'past';
  const cancelled = event.status === 'cancelled';
  const going = event.rsvp?.counts?.going ?? 0;
  const maybe = event.rsvp?.counts?.maybe ?? 0;

  const open = () => router.push(`/events/${event.id}`);
  const openOrganiser = () => router.push(`/u/${event.organiser.id}`);

  return (
    <View style={[styles.row, cancelled && styles.off]}>
      <Spine />

      <View style={styles.spineColumn}>
        <Pressable
          onPress={openOrganiser}
          accessibilityRole="button"
          accessibilityLabel={`${event.organiser.display_name}’s profile`}
          hitSlop={6}
          style={styles.bead}
        >
          <Avatar user={event.organiser} size="xs" />
        </Pressable>
      </View>

      <View style={styles.card}>
        <Pressable onPress={open} accessibilityRole="button" style={styles.cardBody}>
          {/* The alignment band: the when leads, then the organiser — the same
              first line as a post, so the two read as one kind of entry. Both are
              given an explicit line box of exactly the bead's height, so their
              centres land on the bead's without any nudging. */}
          <View style={styles.band}>
            <When event={event} past={past} />
            <Text
              style={styles.organiser}
              numberOfLines={1}
              onPress={openOrganiser}
              accessibilityRole="button"
            >
              {event.organiser.display_name}
            </Text>
            {/* No "Happened" tag on a past entry. Its position says it — it sits
                below the now-node under a day divider that dates it, among posts
                that are equally in the past and carry no such label. "Cancelled"
                stays, because that one *isn't* legible from position: a called-off
                event is a tombstone, not a memory, and nothing else says so. */}
            {cancelled ? <Text style={styles.tagOff}>Cancelled</Text> : null}
          </View>

          <Text style={[styles.title, past && styles.titlePast]} numberOfLines={2}>
            {event.title}
          </Text>

          {!past && event.description ? (
            <Text style={styles.description} numberOfLines={2}>
              {event.description}
            </Text>
          ) : null}

          {/* The Date · Time · Where pills stay on a past event too — the recap
              shows what it settled on, just as the future entry shows what's set,
              and they are now the only place the venue is written (the band above
              carries the clock time alone, and the organiser and the when used to
              be repeated in a meta line under the title).

              So a past recap does state its date twice: once on the day divider
              above it, once in the Date chip. That's deliberate — the chips are
              the record of what the event settled on, and a recap missing the one
              decision it's most defined by reads as though it never got a date.
              The divider is a property of the *timeline*, not of the event. */}
          <View style={styles.chips}>
            <DimensionChips event={event} />
          </View>

          {past
            ? going > 0 && <Text style={styles.turnout}>{going} went</Text>
            : (going > 0 || maybe > 0) && (
                <Text style={styles.turnout}>
                  {going} going{maybe > 0 ? ` · ${maybe} maybe` : ''}
                </Text>
              )}
        </Pressable>

        {/* The same reaction row a post on this spine carries. Outside the
            Pressable above for the reason `PostCard` keeps its own outside: a tap
            meant for a chip must never be swallowed by the card behind it.

            **The thread itself stays on the event screen**, unlike a post's,
            which opens its own screen anyway. An event's conversation sits beside
            its polls, its RSVP and its chips, so the count links there rather
            than unfolding all of that into a timeline row. */}
        <ReactionBar
          eventId={event.id}
          reactions={event.reactions}
          trailing={
            <Pressable onPress={open} accessibilityRole="button" hitSlop={6}>
              <Text style={styles.comments}>
                {event.comment_count > 0
                  ? `${event.comment_count} ${
                      event.comment_count === 1 ? 'comment' : 'comments'
                    }`
                  : 'Comment'}
                {event.new_comment_count > 0 ? (
                  <Text style={styles.newComments}>
                    {' '}
                    · {event.new_comment_count} new
                  </Text>
                ) : null}
              </Text>
            </Pressable>
          }
        />
      </View>
    </View>
  );
}

/**
 * The event's "when", leading the band where a post's clock time does.
 *
 * A **past** event shows only its clock time, like a post: the day divider it
 * sits under already carries the date, and repeating it in the body is how the
 * two came to disagree in the first place. A **future** event carries the whole
 * date in accent, because there are no day dividers above the now boundary to
 * carry it for it.
 *
 * All of it is the event's own wall clock (`formatEvent*`), never `starts_at`
 * read in the viewer's zone — see `eventFormat.ts`.
 */
function When({ event, past }: { event: Event; past: boolean }) {
  if (past) {
    const parts = formatEventTimeParts(event.start_time);
    return (
      <Text style={styles.when} numberOfLines={1}>
        {parts ? parts.time : 'all day'}
        {parts ? <Text style={styles.meridiem}>{parts.meridiem}</Text> : null}
      </Text>
    );
  }
  const date = formatEventDate(event.event_date);
  const time = formatEventTime(event.start_time);
  return (
    <Text style={[styles.when, styles.whenFuture]} numberOfLines={1}>
      {date ? (time ? `${date} · ${time}` : date) : 'Being planned'}
    </Text>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', paddingRight: spacing.md },
  off: { opacity: 0.6 },
  spineColumn: { width: SPINE_COLUMN, alignItems: 'center' },
  bead: {
    // A surface-coloured halo separates the bead from the line behind it.
    borderWidth: BEAD_BORDER,
    borderColor: colors.surface,
    borderRadius: radius.pill,
  },
  card: {
    flex: 1,
    paddingTop: BEAD_BORDER,
    paddingBottom: spacing.lg,
    // A little air off the spine column, not a full indent — the point of
    // moving the line to the edge was to give this column the width back.
    paddingLeft: spacing.sm,
  },
  // The tappable content. Split from `card` so the reaction row can sit outside
  // it: a tap meant for a chip must never be swallowed by the card behind it,
  // the same split `PostCard` makes for its chips and photos.
  cardBody: { gap: spacing.xs },
  band: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  when: {
    fontSize: fontSize.sm,
    color: colors.inkSoft,
    // **No `fonts.mono` here, deliberately** — `PostCard`'s clock time doesn't
    // use it either, and these two sit in the same column of the same spine. A
    // mono event time beside a system-font post time is a different width, so
    // the organiser's name and the author's name below it would start at
    // different x — the exact column alignment this whole change exists to
    // establish. (`docs/design-system.md` does call mono the voice of time, and
    // the *web* honours that on both; mobile's `PostCard` is the one that
    // doesn't. Making them both mono is a feed-wide change and its own issue —
    // what matters here is that the two agree.)
    //
    // Tabular figures so times down the column don't shuffle as the digits
    // change — the same reason `PostCard` asks for them.
    fontVariant: ['tabular-nums'],
    // The explicit bead-height line box that puts this on the bead's centre.
    lineHeight: BEAD,
  },
  whenFuture: { color: colors.accentDeep, fontWeight: '600' },
  meridiem: { fontSize: 11, color: colors.inkFaint },
  organiser: {
    fontSize: fontSize.base,
    fontWeight: '600',
    color: colors.ink,
    lineHeight: BEAD,
    flexShrink: 1,
  },
  title: { fontSize: fontSize.base, fontWeight: '700', color: colors.ink },
  titlePast: { color: colors.inkSoft, fontWeight: '600' },
  description: { fontSize: fontSize.sm, color: colors.inkSoft, lineHeight: 20 },
  chips: { marginTop: 2 },
  turnout: { fontSize: 11, color: colors.inkFaint },
  comments: { fontSize: fontSize.sm, color: colors.inkFaint },
  newComments: { color: colors.accent, fontWeight: '600' },
  tagOff: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.danger,
    textTransform: 'uppercase',
    lineHeight: BEAD,
  },
});
