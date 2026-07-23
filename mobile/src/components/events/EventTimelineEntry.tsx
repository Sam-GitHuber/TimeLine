/**
 * An event as an entry *on* the timeline spine — the same shape as a `PostCard`
 * (a bead on the line, the time leading the entry, the content hanging off it),
 * so an event reads as part of the one continuous line rather than a boxed card
 * wedged into it. Used where an event threads the spine among posts.
 *
 * `variant` decides the voice:
 *   - `"past"` (below the now boundary, among the posts) — a quiet **recap**: the
 *     rail shows the event's clock time like a post (the day divider already
 *     carries the date), and the body is a one-line mono recap + turnout. This is
 *     what E3b weaves into the group timeline.
 *   - `"future"` (above the now boundary) — the date leads in accent and the body
 *     carries the live chips. Available for parity; E3b's group page renders the
 *     upcoming region as `EventCard`s in the header instead (see the mobile note
 *     in events.md / the phase plan), so `"past"` is the variant in use.
 *
 * Ported from `frontend/src/components/events/EventTimelineEntry.jsx`; the spine
 * geometry (bead column, halo, inline time) mirrors `PostCard` exactly so the
 * line never breaks between a post and an event.
 */

import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '../Avatar';
import { SPINE_COLUMN, Spine } from '../timeline';
import { DimensionChips } from './DimensionChips';
import {
  formatEventTimeParts,
  formatEventWhen,
  parseEventDate,
} from '@/eventFormat';
import { colors, fontSize, fonts, radius, spacing } from '@/theme';
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
        <Rail event={event} past={past} />
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

      <Pressable style={styles.card} onPress={open} accessibilityRole="button">
        <View style={styles.titleRow}>
          {past && !cancelled ? <Text style={styles.tagMuted}>Happened</Text> : null}
          <Text style={[styles.title, past && styles.titlePast]} numberOfLines={2}>
            {event.title}
          </Text>
          {cancelled ? <Text style={styles.tagOff}>Cancelled</Text> : null}
        </View>

        <Text style={styles.meta}>
          {event.organiser.display_name}
          {' · '}
          <Text style={styles.metaMono}>{formatEventWhen(event)}</Text>
          {event.location_name ? ` · ${event.location_name}` : ''}
        </Text>

        {!past && event.description ? (
          <Text style={styles.description} numberOfLines={2}>
            {event.description}
          </Text>
        ) : null}

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
    </View>
  );
}

// The rail's voice-of-time: a past event shows its clock time like a post (the
// day divider carries the date); a future event shows its date in accent (there
// are no day dividers above the now boundary).
function Rail({ event, past }: { event: Event; past: boolean }) {
  if (past) {
    const parts = formatEventTimeParts(event.start_time);
    if (parts) {
      return (
        <Text style={styles.railPast} numberOfLines={2}>
          {parts.time}
          {'\n'}
          {parts.meridiem}
        </Text>
      );
    }
    return (
      <Text style={styles.railPast} numberOfLines={2}>
        all{'\n'}day
      </Text>
    );
  }
  const d = parseEventDate(event.event_date);
  return (
    <Text style={styles.railFuture} numberOfLines={2}>
      {d ? d.getDate() : ''}
      {'\n'}
      {d ? d.toLocaleDateString(undefined, { month: 'short' }) : ''}
    </Text>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', paddingRight: spacing.md },
  off: { opacity: 0.6 },
  spineColumn: { width: SPINE_COLUMN, alignItems: 'center' },
  railPast: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.inkFaint,
    textAlign: 'center',
    marginBottom: 2,
  },
  railFuture: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.accentDeep,
    textAlign: 'center',
    marginBottom: 2,
    fontWeight: '600',
  },
  bead: {
    borderWidth: BEAD_BORDER,
    borderColor: colors.surface,
    borderRadius: radius.pill,
  },
  card: { flex: 1, paddingTop: BEAD_BORDER, paddingBottom: spacing.lg, paddingLeft: spacing.sm, gap: spacing.xs },
  titleRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs },
  title: { fontSize: fontSize.base, fontWeight: '700', color: colors.ink, flexShrink: 1, lineHeight: BEAD },
  titlePast: { color: colors.inkSoft, fontWeight: '600' },
  meta: { fontSize: fontSize.sm, color: colors.inkFaint },
  metaMono: { fontFamily: fonts.mono },
  description: { fontSize: fontSize.sm, color: colors.inkSoft, lineHeight: 20 },
  chips: { marginTop: 2 },
  turnout: { fontSize: 11, color: colors.inkFaint },
  tagMuted: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.inkFaint,
    textTransform: 'uppercase',
    lineHeight: BEAD,
  },
  tagOff: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.danger,
    textTransform: 'uppercase',
    lineHeight: BEAD,
  },
});
