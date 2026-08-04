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
import { ReactionBar } from '../ReactionBar';
import { formatEventWhen } from '@/eventFormat';
import { colors, fontSize, fonts, radius, spacing } from '@/theme';
import type { Event } from '@/types';

export function EventCard({
  event,
  showGroup = false,
  showActions = false,
}: {
  event: Event;
  showGroup?: boolean;
  /**
   * Show the reaction row and comment count, as a post on the group timeline
   * has. **On for the group page's upcoming region, off everywhere else.**
   *
   * The group page is the one place this card stands in for a timeline entry —
   * the web renders its upcoming events as `EventTimelineEntry`s, which carry
   * the row, so without this the phone's most-visible events would be the only
   * ones you couldn't react to. The other callers are the calendar agenda and a
   * month grid's day list, which are *indexes*: dense, scannable, and somewhere
   * you tap through rather than act in place.
   */
  showActions?: boolean;
}) {
  const cancelled = event.status === 'cancelled';
  const past = event.is_past;
  const going = event.rsvp?.counts?.going ?? 0;
  const maybe = event.rsvp?.counts?.maybe ?? 0;

  const open = () => router.push(`/events/${event.id}`);

  // The reaction row and the comment count, when this card is standing in for a
  // timeline entry. Rendered *outside* the card's own Pressable by the callers
  // below, so a tap meant for a chip can't be swallowed by the card behind it —
  // the same split `PostCard` and `EventTimelineEntry` make.
  const actions = showActions ? (
    <View style={styles.actions}>
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
  ) : null;

  if (past && !cancelled) {
    return (
      <View style={[styles.card, styles.recap]}>
        <Pressable onPress={open} accessibilityRole="button" style={styles.recapBody}>
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
        {actions}
      </View>
    );
  }

  return (
    <View style={[styles.card, cancelled && styles.cancelled]}>
      <Pressable onPress={open} accessibilityRole="button" style={styles.body}>
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
      {actions}
    </View>
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
  // The tappable content, split from the card so the reaction row can sit
  // outside it (see `actions`).
  body: { gap: spacing.sm },
  recapBody: { gap: spacing.xs },
  actions: { marginTop: spacing.xs },
  comments: { fontSize: fontSize.sm, color: colors.inkFaint },
  newComments: { color: colors.accent, fontWeight: '600' },
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
