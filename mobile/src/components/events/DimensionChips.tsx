/**
 * The event's decision chips — Date · Time · Where (+ one per custom poll) —
 * each rendering its own state so an event's readiness is legible at a glance:
 *
 *   - `set`     — the value, in mono ("Sat 19 Jul", "7:00pm", a place).
 *   - `polling` — a live vote count ("3 votes"), a poll is open on it.
 *   - `unset`   — "not set".
 *
 * **The organiser's control surface.** When `canManage` is true these chips
 * double as the organiser's controls: an unset built-in offers **Set · Poll**, a
 * set one shows the value with **Change · Poll** — each opens the contextual
 * `DimensionEditor` via `onAction(dimension, 'set' | 'poll')`. A `polling` chip
 * stays a read-only tally (its poll is managed in the `PollTally` card below).
 * Members — and the summary cards — pass no `canManage`, so the chips stay
 * glanceable status. Ported from
 * `frontend/src/components/events/DimensionChips.jsx`. See events.md.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatEventDate, formatEventTime } from '@/eventFormat';
import { colors, fontSize, fonts, radius, spacing } from '@/theme';
import type { Event, Poll } from '@/types';

const LABELS: Record<'date' | 'time' | 'location', string> = {
  date: 'Date',
  time: 'Time',
  location: 'Where',
};

type BuiltinDim = 'date' | 'time' | 'location';

type ChipModel = {
  key: string;
  /** The dimension a Set/Change acts on, or null for a display-only custom chip. */
  dim: BuiltinDim | null;
  label: string;
  state: 'set' | 'polling' | 'unset';
  value: string;
  total: number;
};

export function DimensionChips({
  event,
  canManage = false,
  onAction,
}: {
  event: Event;
  canManage?: boolean;
  /** The organiser tapped Set/Change (finalise) or Poll on a built-in dimension. */
  onAction?: (dimension: BuiltinDim, mode: 'set' | 'poll') => void;
}) {
  const dims = event.dimensions;
  const polls = event.polls ?? [];

  const builtins: ChipModel[] = (['date', 'time', 'location'] as const).map((key) => ({
    key,
    dim: key,
    label: LABELS[key],
    state: dims[key]?.state ?? 'unset',
    value: dimensionValue(event, key),
    total: pollTotal(polls, dims[key]?.poll ?? null),
  }));

  // One extra chip per custom poll (e.g. "What to bring?"). A custom decision is
  // pinned from the poll tally, so these are display-only (no built-in field).
  const customs: ChipModel[] = polls
    .filter((p) => p.dimension === 'custom')
    .map((p) => ({
      key: `custom-${p.id}`,
      dim: null,
      label: p.question,
      state: p.decided_option ? 'set' : p.status === 'open' ? 'polling' : 'unset',
      value: decidedLabel(p),
      total: pollTotal(polls, p.id),
    }));

  return (
    <View style={styles.row} accessibilityLabel="Event details">
      {[...builtins, ...customs].map((chip) => (
        <Chip key={chip.key} chip={chip} canManage={canManage} onAction={onAction} />
      ))}
    </View>
  );
}

function Chip({
  chip,
  canManage,
  onAction,
}: {
  chip: ChipModel;
  canManage: boolean;
  onAction?: (dimension: BuiltinDim, mode: 'set' | 'poll') => void;
}) {
  const { dim, label, state, value, total } = chip;
  // Set/Change/Poll act on a built-in dimension only, for the organiser.
  const manage = canManage && dim ? onAction : undefined;

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
        {manage && dim ? (
          <View style={styles.actions}>
            <ChipAction verb="Change" chipLabel={label} onPress={() => manage(dim, 'set')} />
            <Text style={styles.sep}>·</Text>
            <ChipAction verb="Poll" chipLabel={label} onPress={() => manage(dim, 'poll')} />
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <View style={[styles.chip, styles.chipUnset]}>
      <Text style={styles.label}>{label}</Text>
      {manage && dim ? (
        <View style={styles.actions}>
          <ChipAction verb="Set" chipLabel={label} onPress={() => manage(dim, 'set')} />
          <Text style={styles.sep}>·</Text>
          <ChipAction verb="Poll" chipLabel={label} onPress={() => manage(dim, 'poll')} />
        </View>
      ) : (
        <Text style={styles.value}>not set</Text>
      )}
    </View>
  );
}

// The visible label is the short verb; the accessibility label folds in the
// dimension ("Set Date", "Poll Where") so every chip's actions stay
// distinguishable to a screen reader — and to a test.
function ChipAction({
  verb,
  chipLabel,
  onPress,
}: {
  verb: 'Set' | 'Change' | 'Poll';
  chipLabel: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${verb} ${chipLabel}`}
      hitSlop={6}
    >
      <Text style={styles.action}>{verb}</Text>
    </Pressable>
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
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  action: { fontSize: fontSize.sm, fontWeight: '700', color: colors.accentDeep },
  sep: { fontSize: fontSize.sm, color: colors.inkFaint },
  valueMono: { fontFamily: fonts.mono, color: colors.ink },
  valueAccent: { color: colors.accentDeep, fontWeight: '600' },
});
