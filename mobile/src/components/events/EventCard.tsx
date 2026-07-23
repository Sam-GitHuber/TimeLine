/**
 * One event as a summary card, tapping through to its detail screen. Three
 * render branches on the *same* event (never a separate model):
 *
 *   - a live planning/scheduled event → organiser + when + the dimension chips,
 *   - a past event → a quiet "recap" card (it's become a memory),
 *   - a cancelled event → a dimmed tombstone.
 *
 * `showGroup` labels the event with its group — the personal calendar wants it;
 * a single group's own list doesn't. Ported from
 * `frontend/src/components/events/EventCard.jsx`.
 *
 * This is the boxed, *off-the-line* form (the group page's upcoming section, the
 * date-less staging strip, the calendar agenda). On the timeline spine an event
 * uses `EventTimelineEntry` instead, so it threads the line like a post.
 */

import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '../Avatar';
import { formatEventWhen } from '@/eventFormat';
import { colors, fontSize, fonts, radius, spacing } from '@/theme';
import type { Event } from '@/types';

export function EventCard({
  event,
  showGroup = false,
}: {
  event: Event;
  showGroup?: boolean;
}) {
  const cancelled = event.status === 'cancelled';
  const past = event.is_past;
  const going = event.rsvp?.counts?.going ?? 0;
  const maybe = event.rsvp?.counts?.maybe ?? 0;

  const open = () => router.push(`/events/${event.id}`);

  if (past && !cancelled) {
    return (
      <Pressable style={[styles.card, styles.recap]} onPress={open} accessibilityRole="button">
        <View style={styles.recapHead}>
          <Text style={styles.tag}>Event · happened</Text>
          {showGroup ? <Text style={styles.groupLabel}>{event.group.name}</Text> : null}
        </View>
        <Text style={styles.recapTitle}>{event.title}</Text>
        <Text style={styles.recapWhen}>
          {formatEventWhen(event)}
          {event.location_name ? ` · ${event.location_name}` : ''}
        </Text>
        <Text style={styles.meta}>{going > 0 ? `${going} went` : 'no turnout recorded'}</Text>
      </Pressable>
    );
  }

  return (
    <Pressable
      style={[styles.card, cancelled && styles.cancelled]}
      onPress={open}
      accessibilityRole="button"
    >
      <View style={styles.headRow}>
        <Avatar user={event.organiser} size="sm" />
        <View style={styles.headBody}>
          <View style={styles.titleRow}>
            <Text style={styles.title} numberOfLines={2}>
              {event.title}
            </Text>
            {cancelled ? <Text style={styles.tagOff}>Cancelled</Text> : null}
            {showGroup ? <Text style={styles.groupLabel}>{event.group.name}</Text> : null}
          </View>
          <Text style={styles.meta}>
            {event.organiser.display_name}
            {event.event_date ? ` · ${formatEventWhen(event)}` : ' · being planned'}
          </Text>
        </View>
      </View>

      {event.description ? (
        <Text style={styles.description} numberOfLines={2}>
          {event.description}
        </Text>
      ) : null}

      {(going > 0 || maybe > 0) && (
        <Text style={styles.meta}>
          {going} going{maybe > 0 ? ` · ${maybe} maybe` : ''}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.sm,
  },
  cancelled: { opacity: 0.6 },
  headRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  headBody: { flex: 1, gap: 2 },
  titleRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs },
  title: { fontSize: fontSize.lg, fontWeight: '700', color: colors.ink, flexShrink: 1 },
  meta: { fontSize: fontSize.sm, color: colors.inkFaint },
  description: { fontSize: fontSize.sm, color: colors.inkSoft, lineHeight: 20 },
  tag: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.inkFaint,
    textTransform: 'uppercase',
  },
  tagOff: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.danger,
    textTransform: 'uppercase',
  },
  groupLabel: { fontSize: fontSize.sm, fontStyle: 'italic', color: colors.inkFaint },
  // Past recap: quieter, no avatar, mono "when".
  recap: { gap: spacing.xs },
  recapHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  recapTitle: { fontSize: fontSize.base, fontWeight: '700', color: colors.inkSoft },
  recapWhen: { fontFamily: fonts.mono, fontSize: fontSize.sm, color: colors.inkFaint },
});
