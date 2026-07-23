/**
 * The RSVP control + summary. **Counts are complete** across the whole audience
 * (decision 2 in events.md); the named avatar lists are **connection-gated** —
 * you see who's going only among your own connections, everyone else adds to the
 * count as an anonymous +1. One RSVP per person, upserted.
 *
 * Ported from `frontend/src/components/events/RsvpBar.jsx`. The guests + note
 * detail appears only once you've chosen "Going"; changing them re-submits.
 */

import { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Avatar } from '../Avatar';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { Author, Event } from '@/types';

const RESPONSES = [
  { key: 'going', label: 'Going' },
  { key: 'maybe', label: 'Maybe' },
  { key: 'declined', label: "Can't go" },
] as const;

type Response = (typeof RESPONSES)[number]['key'];

export function RsvpBar({
  event,
  onRsvp,
  busy,
}: {
  event: Event;
  onRsvp: (body: { response: Response; guests: number; note: string }) => void;
  busy: boolean;
}) {
  const rsvp = event.rsvp;
  const mine = rsvp?.your_response ?? null;
  const counts = rsvp?.counts ?? { going: 0, maybe: 0, declined: 0, guests: 0 };
  const [guests, setGuests] = useState(String(mine?.guests ?? 0));
  const [note, setNote] = useState(mine?.note ?? '');
  const cancelled = event.status === 'cancelled';

  const guestsNum = () => Math.max(0, Math.min(50, Number(guests) || 0));

  function choose(response: Response) {
    if (cancelled) return;
    onRsvp({ response, guests: guestsNum(), note });
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.buttons} accessibilityLabel="Your RSVP">
        {RESPONSES.map((r) => {
          const active = mine?.response === r.key;
          return (
            <Pressable
              key={r.key}
              disabled={busy || cancelled}
              onPress={() => choose(r.key)}
              accessibilityRole="button"
              accessibilityState={{ selected: active, disabled: busy || cancelled }}
              style={[styles.btn, active ? styles.btnActive : styles.btnGhost]}
            >
              <Text style={[styles.btnText, active && styles.btnTextActive]}>
                {r.label}
              </Text>
              <Text style={[styles.count, active && styles.countActive]}>
                {counts[r.key] || 0}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {mine?.response === 'going' && !cancelled ? (
        <View style={styles.detail}>
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Guests</Text>
            <TextInput
              value={guests}
              onChangeText={setGuests}
              keyboardType="number-pad"
              maxLength={2}
              style={styles.guestInput}
              accessibilityLabel="Number of guests you're bringing"
            />
          </View>
          <View style={[styles.field, styles.noteField]}>
            <Text style={styles.fieldLabel}>Note</Text>
            <TextInput
              value={note}
              onChangeText={setNote}
              maxLength={200}
              placeholder="optional — e.g. running 10 min late"
              placeholderTextColor={colors.inkFaint}
              style={styles.noteInput}
              accessibilityLabel="A note on your RSVP"
            />
          </View>
          <Pressable
            disabled={busy}
            onPress={() => onRsvp({ response: 'going', guests: guestsNum(), note })}
            accessibilityRole="button"
            style={[styles.btn, styles.btnGhost]}
          >
            <Text style={styles.btnText}>Update</Text>
          </Pressable>
        </View>
      ) : null}

      {counts.guests > 0 ? (
        <Text style={styles.guestsLine}>
          + {counts.guests} guest{counts.guests === 1 ? '' : 's'}
        </Text>
      ) : null}

      <NamedList title="Going" people={rsvp?.going_list} />
      <NamedList title="Maybe" people={rsvp?.maybe_list} />
    </View>
  );
}

function NamedList({ title, people }: { title: string; people?: Author[] }) {
  if (!people || people.length === 0) return null;
  return (
    <View style={styles.named}>
      <Text style={styles.namedTitle}>{title}:</Text>
      {people.map((p) => (
        <Avatar key={p.id} user={p} size="xs" />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  btnGhost: { backgroundColor: colors.raised, borderColor: colors.lineStrong },
  btnActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  btnText: { fontSize: fontSize.sm, fontWeight: '600', color: colors.ink },
  btnTextActive: { color: colors.raised },
  count: { fontSize: 11, color: colors.inkFaint, fontVariant: ['tabular-nums'] },
  countActive: { color: colors.raised, opacity: 0.85 },
  detail: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: spacing.sm },
  field: { gap: 2 },
  noteField: { flex: 1, minWidth: 160 },
  fieldLabel: { fontSize: 11, color: colors.inkFaint, fontWeight: '600' },
  guestInput: {
    width: 56,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    backgroundColor: colors.raised,
    color: colors.ink,
    fontSize: fontSize.sm,
  },
  noteInput: {
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    backgroundColor: colors.raised,
    color: colors.ink,
    fontSize: fontSize.sm,
  },
  guestsLine: { fontSize: 11, color: colors.inkFaint },
  named: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs },
  namedTitle: { fontSize: 11, fontWeight: '600', color: colors.inkFaint },
});
