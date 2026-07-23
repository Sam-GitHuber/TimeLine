/**
 * The event detail screen (`/events/[eventId]`) — the deep-link a notification
 * opens, and where members read an event and take part: see the dimension chips,
 * vote in polls, and RSVP.
 *
 * A **root-stack sibling** (not under the tab group), like `post/` and `u/`, so
 * it covers the tab bar full-screen — the expected native behaviour for a pushed
 * detail. An event you're not connected to the organiser of is a **404**; it
 * renders as "not available" rather than leaking that it exists (events.md).
 *
 * **E3b was read + participate.** **E3c-a** adds the organiser's *set* surface —
 * the chip **Set/Change** → the contextual `DimensionEditor` → **finalise**, plus
 * **cancel/delete**. The **poll** control (open/edit/close/reopen) is E3c-b, so
 * `PollTally` here is still vote-only. Ported from
 * `frontend/src/pages/EventPage.jsx`.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api, ApiError } from '@/api';
import { Avatar } from '@/components/Avatar';
import { DimensionChips } from '@/components/events/DimensionChips';
import { DimensionEditor } from '@/components/events/DimensionEditor';
import { PollTally } from '@/components/events/PollTally';
import { RsvpBar } from '@/components/events/RsvpBar';
import { formatEventWhen } from '@/eventFormat';
import { colors, fontSize, fonts, radius, spacing } from '@/theme';

type BuiltinDim = 'date' | 'time' | 'location';

/**
 * Whether an organiser-pasted location link is safe to open. `Linking.openURL`
 * will fire *any* scheme — `javascript:`, `tel:`, a custom app deep-link — so a
 * link is only shown/opened when it's plainly **http(s)**. The value is
 * attacker-controlled (any group member can organise an event), so this guards
 * both the affordance and the tap.
 */
function isSafeHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

export default function EventScreen() {
  const { eventId } = useLocalSearchParams<{ eventId: string }>();
  const id = Number(eventId);
  const queryClient = useQueryClient();

  // Which built-in dimension's editor is open (organiser's Set/Change), or null.
  const [editing, setEditing] = useState<BuiltinDim | null>(null);

  const eventQuery = useQuery({
    queryKey: ['event', id],
    queryFn: () => api.getEvent(id),
    retry: false,
  });
  const event = eventQuery.data;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['event', id] });
    if (event) {
      // The group's upcoming/past lists and calendars show the same RSVP/vote
      // tallies and dimension values, so keep them in step once this write lands.
      queryClient.invalidateQueries({ queryKey: ['groupEvents', event.group.id] });
      queryClient.invalidateQueries({ queryKey: ['groupCalendar', event.group.id] });
      queryClient.invalidateQueries({ queryKey: ['personalCalendar'] });
    }
  };

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else if (event) router.replace(`/groups/${event.group.id}`);
    else router.replace('/groups');
  };

  const rsvp = useMutation({
    mutationFn: (body: Parameters<typeof api.rsvpEvent>[1]) => api.rsvpEvent(id, body),
    onSuccess: invalidate,
  });
  const vote = useMutation({
    mutationFn: ({ pollId, optionIds }: { pollId: number; optionIds: number[] }) =>
      api.votePoll(pollId, optionIds),
    onSuccess: invalidate,
  });
  // The organiser's decision on a built-in dimension (advisory finalise).
  const finalise = useMutation({
    mutationFn: ({ dimension, value }: { dimension: BuiltinDim; value: string }) =>
      api.finaliseDimension(id, { dimension, value }),
    onSuccess: () => {
      setEditing(null);
      invalidate();
    },
    onError: (err) =>
      Alert.alert('Couldn’t save', err instanceof Error ? err.message : 'Something went wrong.'),
  });
  const cancel = useMutation({
    mutationFn: () => api.cancelEvent(id),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteEvent(id),
    onSuccess: () => {
      invalidate();
      goBack();
    },
  });

  function confirmCancel() {
    Alert.alert('Cancel this event?', 'People who RSVP’d will be notified.', [
      { text: 'Keep it', style: 'cancel' },
      { text: 'Cancel event', style: 'destructive', onPress: () => cancel.mutate() },
    ]);
  }
  function confirmDelete() {
    Alert.alert('Delete this event?', 'This deletes it for everyone and can’t be undone.', [
      { text: 'Keep it', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => remove.mutate() },
    ]);
  }

  const notFound = eventQuery.error instanceof ApiError && eventQuery.error.status === 404;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.topBar}>
        <Pressable onPress={goBack} accessibilityRole="button" accessibilityLabel="Back" hitSlop={8}>
          <Text style={styles.back}>← {event ? event.group.name : 'Back'}</Text>
        </Pressable>
      </View>

      {eventQuery.isLoading ? (
        <ActivityIndicator color={colors.accent} style={styles.spinner} />
      ) : notFound || !event ? (
        <View style={styles.centre}>
          <Text style={styles.emptyTitle}>Event not available</Text>
          <Text style={styles.emptyBody}>
            It may have been cancelled, or you’re not connected to whoever organised it.
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.titleRow}>
            <Text style={styles.title}>{event.title}</Text>
            {event.status === 'cancelled' ? (
              <Text style={styles.tagOff}>Cancelled</Text>
            ) : event.is_past ? (
              <Text style={styles.tag}>Happened</Text>
            ) : null}
          </View>

          <Pressable
            style={styles.organiser}
            onPress={() => router.push(`/u/${event.organiser.id}`)}
            accessibilityRole="button"
          >
            <Avatar user={event.organiser} size="xs" />
            <Text style={styles.organiserText}>Organised by {event.organiser.display_name}</Text>
          </Pressable>

          {event.event_date ? (
            <Text style={styles.when}>{formatEventWhen(event)}</Text>
          ) : null}

          {event.description ? <Text style={styles.description}>{event.description}</Text> : null}

          {event.location_name ? (
            <Text style={styles.location}>
              {event.location_name}
              {isSafeHttpUrl(event.location_url) ? (
                <Text
                  style={styles.locationLink}
                  onPress={() => Linking.openURL(event.location_url).catch(() => {})}
                  accessibilityRole="link"
                >
                  {'  ·  link'}
                </Text>
              ) : null}
            </Text>
          ) : null}

          {event.status !== 'cancelled' ? (
            <View style={styles.section}>
              <DimensionChips
                event={event}
                canManage={event.can_manage}
                onAction={(dimension) => setEditing(dimension)}
              />
              {editing ? (
                <DimensionEditor
                  dimension={editing}
                  busy={finalise.isPending}
                  onSet={(dimension, value) => finalise.mutate({ dimension, value })}
                  onCancel={() => setEditing(null)}
                />
              ) : null}
            </View>
          ) : null}

          {(event.polls ?? []).length > 0 ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Polls</Text>
              {event.polls.map((poll) => (
                <PollTally
                  key={poll.id}
                  poll={poll}
                  busy={vote.isPending}
                  onVote={(optionIds) => vote.mutate({ pollId: poll.id, optionIds })}
                />
              ))}
            </View>
          ) : null}

          {event.status !== 'cancelled' ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Are you going?</Text>
              <RsvpBar event={event} busy={rsvp.isPending} onRsvp={(b) => rsvp.mutate(b)} />
            </View>
          ) : null}

          {/* Cancel/delete — the organiser or a group admin (`can_moderate`).
              Cancel soft-cancels (a tombstone that notifies RSVPs); delete is a
              hard, everyone removal. */}
          {event.can_moderate ? (
            <View style={styles.section}>
              <View style={styles.moderate}>
                {event.status !== 'cancelled' ? (
                  <Pressable
                    onPress={confirmCancel}
                    disabled={cancel.isPending}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.dangerBtn, pressed && styles.pressed]}
                  >
                    <Text style={styles.dangerLabel}>Cancel event</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  onPress={confirmDelete}
                  disabled={remove.isPending}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.dangerBtn, pressed && styles.pressed]}
                >
                  <Text style={styles.dangerLabel}>Delete event</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  topBar: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  back: { fontSize: fontSize.sm, color: colors.inkFaint, fontWeight: '600' },
  spinner: { marginTop: spacing.xl },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.lg, fontWeight: '700', color: colors.ink, textAlign: 'center' },
  emptyBody: { fontSize: fontSize.sm, color: colors.inkSoft, textAlign: 'center', lineHeight: 20 },
  content: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.xxl },
  titleRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  title: { fontSize: fontSize.xl, fontWeight: '700', color: colors.ink, flexShrink: 1 },
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
  organiser: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  organiserText: { fontSize: fontSize.sm, color: colors.inkFaint },
  when: { fontFamily: fonts.mono, fontSize: fontSize.base, color: colors.inkSoft },
  description: { fontSize: fontSize.base, color: colors.inkSoft, lineHeight: 23 },
  location: { fontSize: fontSize.sm, color: colors.inkSoft },
  locationLink: { color: colors.accentDeep, fontWeight: '600' },
  section: {
    marginTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingTop: spacing.md,
    gap: spacing.sm,
  },
  sectionTitle: { fontSize: fontSize.base, fontWeight: '700', color: colors.ink },
  moderate: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  dangerBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
  },
  dangerLabel: { fontSize: fontSize.sm, fontWeight: '600', color: colors.danger },
  pressed: { opacity: 0.7 },
});
