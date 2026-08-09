/**
 * The RSVP control + summary. **Counts are complete** across the whole audience
 * (decision 2 in events.md); the named avatar lists are **connection-gated** —
 * you see who's going only among your own connections, everyone else adds to the
 * count as an anonymous +1. One RSVP per person, upserted.
 *
 * Ported from `frontend/src/components/events/RsvpBar.jsx`. The guests + note
 * detail appears only once you've chosen "Going"; changing them re-submits.
 * `onRsvp` must return a promise that *rejects* on failure — that rejection is
 * the only thing that says an RSVP didn't save (#229).
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
import { serverMessage } from '@/api';
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
  // A promise, not `void`: the rejection has to reach this component, because
  // the guests and note are typed in here and nothing else says they failed to
  // save (#229). `EventScreen` hands it down as `mutateAsync` for that reason.
  onRsvp: (body: { response: Response; guests: number; note: string }) => Promise<unknown>;
  busy: boolean;
}) {
  const rsvp = event.rsvp;
  const mine = rsvp?.your_response ?? null;
  const counts = rsvp?.counts ?? { going: 0, maybe: 0, declined: 0, guests: 0 };
  const cancelled = event.status === 'cancelled';

  // Guests and note are yours to type, but the server owns the answer:
  // `your_response` changes underneath this component whenever the event
  // refetches, and every RSVP/vote/finalise on the screen ends in an invalidate
  // while the screen stays mounted — a foreground return alone is enough, since
  // `_layout.tsx` wires `AppState` to `focusManager`. Seeded once, the two
  // inputs kept a stale answer next to a "+ N guests" summary read from the
  // fresh payload — and pressing Update then posted the stale number back,
  // silently reverting an RSVP made on the web (#229). So they're re-derived
  // whenever the server's answer *changes*, compared by contents: a refetch
  // hands back a fresh object every time, and comparing identity would wipe
  // what you're half-way through typing on every poll of the event.
  const serverKey = rsvpKey(mine);
  const [guests, setGuests] = useState(String(mine?.guests ?? 0));
  const [note, setNote] = useState(mine?.note ?? '');
  const [syncedKey, setSyncedKey] = useState(serverKey);
  // A rejected RSVP: what it tried to save, what the server said at the time,
  // and the message to show.
  const [failed, setFailed] = useState<
    { saved: string; from: string; message: string } | null
  >(null);
  if (syncedKey !== serverKey) {
    setSyncedKey(serverKey);
    setGuests(String(mine?.guests ?? 0));
    setNote(mine?.note ?? '');
  }
  // Clear the failure only once the server has *moved* to the very answer we
  // thought failed — the request landed and only its response was lost, so
  // "didn't save" would now be sitting under an answer that did. Any other
  // change to `your_response` leaves the message standing: it's about your
  // attempt, not about whatever else has happened since.
  //
  // Both halves are compared against keys recorded at the attempt, never
  // against when the sync arrives, so this holds even when the refetch and the
  // rejection land in the same render batch — the trap #231 describes, where a
  // blanket "clear on sync" swallows the message before it is ever painted.
  // `from` is what makes an unchanged Update honest too: re-pressing it without
  // editing anything means `saved` already equals the server's answer, and
  // without `from` the message would be cleared the instant it was set.
  if (failed && serverKey !== failed.from && serverKey === failed.saved) {
    setFailed(null);
  }

  const guestsNum = () => Math.max(0, Math.min(50, Number(guests) || 0));

  // Your typed values stay put on a rejection — the message, not a snap-back,
  // is what tells you it didn't save, and pressing Update again retries without
  // retyping the note. (Until the server itself says otherwise: a later answer
  // arriving from elsewhere is the newer truth and re-seeds the fields above,
  // while the message stands, because your attempt still didn't land.)
  //
  // Like `PollTally`'s rollback, this leans on a deferral recorded in
  // `app/_layout.tsx`: with `onlineManager` left unwired to NetInfo, an offline
  // RSVP *rejects*. Wire it and React Query's default `networkMode: 'online'`
  // would **pause** the mutation instead — `mutateAsync` never settles, so no
  // catch, no message, and the airplane-mode case is silent again.
  async function submit(body: { response: Response; guests: number; note: string }) {
    if (cancelled) return;
    setFailed(null);
    try {
      await onRsvp(body);
    } catch (err) {
      // Without this the failure is silent: the fields keep your text as if it
      // had saved, and the count simply not moving reads as "nobody else has
      // RSVP'd yet" rather than "your change was rejected". Only the server's
      // own words are fit to show — an `ApiError` carries DRF's `detail`,
      // written for a person; everything else is a stand-in of ours, and
      // offline is the case this exists for.
      //
      // `serverMessage`, not a bare `instanceof ApiError`: since #243 a lost
      // connection is re-raised as an `ApiError` as well, so the class alone no
      // longer tells the two apart — `fromServer` does.
      setFailed({
        saved: rsvpKey(body),
        from: serverKey,
        message: serverMessage(err, 'Your RSVP didn’t save — try again.'),
      });
    }
  }

  function choose(response: Response) {
    void submit({ response, guests: guestsNum(), note });
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
            onPress={() => void submit({ response: 'going', guests: guestsNum(), note })}
            accessibilityRole="button"
            style={[styles.btn, styles.btnGhost]}
          >
            <Text style={styles.btnText}>Update</Text>
          </Pressable>
        </View>
      ) : null}

      {failed ? (
        <Text style={styles.error} accessibilityRole="alert">
          {failed.message}
        </Text>
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

/**
 * A fingerprint of an RSVP answer — the server's `your_response` or a body we
 * tried to save — so the two can be compared by contents rather than identity.
 */
function rsvpKey(r: { response: string; guests: number; note: string } | null): string {
  if (!r) return '';
  return `${r.response}|${r.guests || 0}|${r.note || ''}`;
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
  error: { fontSize: fontSize.sm, color: colors.danger },
  guestsLine: { fontSize: 11, color: colors.inkFaint },
  named: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs },
  namedTitle: { fontSize: 11, fontWeight: '600', color: colors.inkFaint },
});
