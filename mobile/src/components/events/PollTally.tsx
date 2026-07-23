/**
 * A poll's tally — each candidate option is a row with a bar that fills as votes
 * arrive and the full count on the right. **The count is complete** across the
 * whole audience (decision 2 in events.md); the voter avatars are only your
 * connections (everyone else folds into the count as an anonymous +1).
 *
 * A member sees a **vote** affordance while the poll is open: tap an option to
 * cast (or, single-choice, tap again to clear); `onVote` gets your *full*
 * selection each time and the server replaces your prior votes with it.
 *
 * **E3b is vote-only.** The organiser's lifecycle controls (finalise, edit,
 * close/reopen, remove) and the "no automatic winner" surface are E3c — the
 * tally informs, the organiser decides. Ported (read/vote side) from
 * `frontend/src/components/events/PollTally.jsx`.
 */

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '../Avatar';
import { formatEventDate, formatEventTime } from '@/eventFormat';
import { colors, fontSize, fonts, radius, spacing } from '@/theme';
import type { Poll, PollResultOption } from '@/types';

export function PollTally({
  poll,
  onVote,
  busy,
}: {
  poll: Poll;
  onVote: (optionIds: number[]) => void;
  busy: boolean;
}) {
  const open = poll.status === 'open';
  const options = poll.options ?? [];
  const max = Math.max(1, ...options.map((o) => o.count || 0));
  // Your selection is seeded once from the server and then owned locally — the
  // same as the web `PollTally`. A cast fires `onVote`, whose success refetches
  // the event for fresh *counts*; the component instance persists, so your
  // selection stays put without a prop→state sync effect (which React flags).
  const [selected, setSelected] = useState<Set<number>>(new Set(poll.your_votes ?? []));

  function toggle(optionId: number) {
    if (!open || busy) return;
    const next = new Set(poll.allow_multiple ? selected : []);
    if (selected.has(optionId)) {
      // Re-tapping a chosen option clears it (in both modes).
      next.delete(optionId);
    } else {
      next.add(optionId);
    }
    setSelected(next);
    onVote(Array.from(next));
  }

  const noVotes = options.every((o) => (o.count || 0) === 0);

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.question}>{poll.question}</Text>
        <Text style={styles.status}>
          {open ? (poll.allow_multiple ? 'open · pick any' : 'open · pick one') : 'closed'}
        </Text>
      </View>

      <View style={styles.options}>
        {options.map((opt) => {
          const chosen = selected.has(opt.id);
          const pct = Math.round(((opt.count || 0) / max) * 100);
          return (
            <View key={opt.id}>
              <Pressable
                disabled={!open || busy}
                onPress={() => toggle(opt.id)}
                accessibilityRole="button"
                accessibilityState={{ selected: chosen, disabled: !open || busy }}
                style={[styles.optionRow, chosen && styles.optionChosen]}
              >
                <View style={[styles.fill, { width: `${pct}%` }, chosen && styles.fillChosen]} />
                <Text style={styles.optionLabel}>{optionLabel(poll, opt)}</Text>
                <Text style={styles.optionCount}>{opt.count || 0}</Text>
              </Pressable>
              {opt.voters && opt.voters.length > 0 ? (
                <View style={styles.voters}>
                  {opt.voters.map((v) => (
                    <Avatar key={v.id} user={v} size="xs" />
                  ))}
                </View>
              ) : null}
            </View>
          );
        })}
      </View>

      {noVotes ? <Text style={styles.empty}>No votes yet.</Text> : null}
    </View>
  );
}

function optionLabel(poll: Poll, opt: PollResultOption): string {
  if (poll.dimension === 'date' && opt.date_value) return formatEventDate(opt.date_value);
  if (poll.dimension === 'time' && opt.time_value) return formatEventTime(opt.time_value);
  return opt.label;
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.lg,
    backgroundColor: colors.raised,
    padding: spacing.md,
    gap: spacing.sm,
  },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: spacing.sm },
  question: { fontSize: fontSize.base, fontWeight: '700', color: colors.ink, flexShrink: 1 },
  status: { fontSize: 11, color: colors.inkFaint },
  options: { gap: spacing.sm },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    minHeight: 40,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  optionChosen: { borderColor: colors.accent },
  fill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: colors.accentTint,
  },
  fillChosen: { backgroundColor: colors.accentTint },
  optionLabel: { fontFamily: fonts.mono, fontSize: fontSize.sm, color: colors.ink, flexShrink: 1 },
  optionCount: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.inkSoft,
    fontVariant: ['tabular-nums'],
  },
  voters: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.xs, paddingLeft: spacing.xs },
  empty: { fontSize: fontSize.sm, color: colors.inkFaint },
});
