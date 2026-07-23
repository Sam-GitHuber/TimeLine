/**
 * The event's decision chips — Date · Time · Where (+ one per custom poll) —
 * each rendering its own state so an event's readiness is legible at a glance:
 *
 *   - `set`     — the value, in mono ("Sat 19 Jul", "7:00pm", a place).
 *   - `polling` — a live vote count ("3 votes"), a poll is open on it.
 *   - `unset`   — "not set".
 *
 * **Read-only in E3b.** On the web these chips double as the organiser's control
 * surface (Set · Poll · Change actions live on them); that control surface is
 * E3c. Here they're a glanceable status wherever an event is shown — the detail
 * header, the timeline entries, the calendar cards. Ported from
 * `frontend/src/components/events/DimensionChips.jsx`. See events.md.
 */

import { StyleSheet, Text, View } from 'react-native';

import { formatEventDate, formatEventTime } from '@/eventFormat';
import { colors, fontSize, fonts, radius, spacing } from '@/theme';
import type { Event, Poll } from '@/types';

const LABELS: Record<'date' | 'time' | 'location', string> = {
  date: 'Date',
  time: 'Time',
  location: 'Where',
};

type ChipModel = {
  key: string;
  label: string;
  state: 'set' | 'polling' | 'unset';
  value: string;
  total: number;
};

export function DimensionChips({ event }: { event: Event }) {
  const dims = event.dimensions;
  const polls = event.polls ?? [];

  const builtins: ChipModel[] = (['date', 'time', 'location'] as const).map((key) => ({
    key,
    label: LABELS[key],
    state: dims[key]?.state ?? 'unset',
    value: dimensionValue(event, key),
    total: pollTotal(polls, dims[key]?.poll ?? null),
  }));

  // One extra chip per custom poll (e.g. "What to bring?"). A custom decision is
  // pinned from the poll tally, so these are display-only.
  const customs: ChipModel[] = polls
    .filter((p) => p.dimension === 'custom')
    .map((p) => ({
      key: `custom-${p.id}`,
      label: p.question,
      state: p.decided_option ? 'set' : p.status === 'open' ? 'polling' : 'unset',
      value: decidedLabel(p),
      total: pollTotal(polls, p.id),
    }));

  return (
    <View style={styles.row} accessibilityLabel="Event details">
      {[...builtins, ...customs].map((chip) => (
        <Chip key={chip.key} chip={chip} />
      ))}
    </View>
  );
}

function Chip({ chip }: { chip: ChipModel }) {
  const { label, state, value, total } = chip;

  if (state === 'polling') {
    const tally = total === 1 ? '1 vote' : `${total} votes`;
    return (
      <View style={[styles.chip, styles.chipPolling]}>
        <Text style={styles.label}>{label}</Text>
        <Text style={[styles.value, styles.valueAccent]}>{tally}</Text>
      </View>
    );
  }

  if (state === 'set') {
    return (
      <View style={[styles.chip, styles.chipSet]}>
        <Text style={styles.label}>{label}</Text>
        {value ? <Text style={[styles.value, styles.valueMono]}>{value}</Text> : null}
      </View>
    );
  }

  return (
    <View style={[styles.chip, styles.chipUnset]}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>not set</Text>
    </View>
  );
}

function dimensionValue(event: Event, key: 'date' | 'time' | 'location'): string {
  if (key === 'date') return formatEventDate(event.event_date);
  if (key === 'location') return event.location_name;
  const start = formatEventTime(event.start_time);
  if (!start) return '';
  const end = formatEventTime(event.end_time);
  return end ? `${start}–${end}` : start;
}

function decidedLabel(poll: Poll): string {
  if (!poll.decided_option) return '';
  const opt = (poll.options ?? []).find((o) => o.id === poll.decided_option);
  return opt ? opt.label : '';
}

function pollTotal(polls: Poll[], pollId: number | null): number {
  if (!pollId) return 0;
  const poll = polls.find((p) => p.id === pollId);
  if (!poll) return 0;
  return (poll.options ?? []).reduce((sum, o) => sum + (o.count || 0), 0);
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  chip: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    borderWidth: 1,
  },
  chipSet: { backgroundColor: colors.accentTint, borderColor: colors.accentTint },
  chipPolling: { backgroundColor: colors.raised, borderColor: colors.accent },
  chipUnset: { backgroundColor: colors.raised, borderColor: colors.line },
  label: { fontSize: 11, fontWeight: '700', color: colors.inkFaint, textTransform: 'uppercase' },
  value: { fontSize: fontSize.sm, color: colors.inkSoft },
  valueMono: { fontFamily: fonts.mono, color: colors.ink },
  valueAccent: { color: colors.accentDeep, fontWeight: '600' },
});
