/**
 * A poll's tally — each candidate option is a row with a bar that fills as votes
 * arrive and the full count on the right. **The count is complete** across the
 * whole audience (decision 2 in events.md); the voter avatars are only your
 * connections (everyone else folds into the count as an anonymous +1).
 *
 * A member sees a **vote** affordance while the poll is open: tap an option to
 * cast (or, single-choice, tap again to clear); `onVote` gets your *full*
 * selection each time and the server replaces your prior votes with it. **Your
 * tick is optimistic**, so `onVote` must return a promise that *rejects* on
 * failure — that rejection is what takes the tick back (#227).
 *
 * **The organiser (`canManage`, E3c-b) also gets the lifecycle:** a **Set/Pin**
 * on each option (finalise it — the tally informs, the organiser decides; there
 * is deliberately no automatic winner), and a **⋯ menu** with Edit (only while
 * unvoted — a cast vote locks the wording, mirrored by the server's 409) / Close
 * or Re-open / Remove. Ported from `frontend/src/components/events/PollTally.jsx`.
 */

import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Avatar } from '../Avatar';
import { PollOptionFields } from './PollOptionFields';
import {
  optionEditValue,
  optionValuePayload,
  type OptionRow,
  type PollDimension,
} from './pollOptions';
import { serverMessage } from '@/api';
import { formatEventDate, formatEventTime } from '@/eventFormat';
import { colors, fontSize, fonts, radius, spacing } from '@/theme';
import type { Poll, PollOptionPayload, PollResultOption } from '@/types';
import { useActionMenu } from '@/components/ActionMenu';
import { useAndroidBack } from '@/useAndroidBack';
import { useHoldOpen, useWriteHold, WriteHoldProvider } from '@/writeHold';

/** What `onFinalise` carries: a free value or a pinned option, for a dimension. */
export type FinaliseArg = { dimension: PollDimension; value?: string; optionId?: number };
export type EditPollPayload = {
  question?: string;
  allowMultiple: boolean;
  options: PollOptionPayload[];
};

export function PollTally({
  poll,
  onVote,
  busy,
  canManage = false,
  onFinalise,
  onEdit,
  onClose,
  onReopen,
  onDelete,
}: {
  poll: Poll;
  // A promise, not `void`: the rejection has to reach this component so the tick
  // it put on screen can be taken back (#227). `EventScreen` hands it down as
  // `mutateAsync` for that reason.
  onVote: (optionIds: number[]) => Promise<unknown>;
  busy: boolean;
  canManage?: boolean;
  onFinalise?: (arg: FinaliseArg) => void;
  onEdit?: (payload: EditPollPayload) => Promise<unknown>;
  onClose?: () => void;
  onReopen?: () => void;
  onDelete?: () => void;
}) {
  const open = poll.status === 'open';
  const options = poll.options ?? [];
  const max = Math.max(1, ...options.map((o) => o.count || 0));
  const isCustom = poll.dimension === 'custom';
  // A poll locks its wording the moment the first vote lands: a cast vote can't be
  // silently redefined. The server enforces the same with a 409.
  const canEdit = canManage && (poll.vote_count || 0) === 0;

  // Your ticks are optimistic — they appear the moment you tap, before the server
  // has agreed. Two things keep that from turning into a lie (#227, the web's
  // #216): `toggle` rolls them back if the request fails, and the server's answer
  // wins whenever it changes underneath us (you voted on the web with this screen
  // open, or your own vote round-tripped). `serverVotes` is a fresh array on every
  // refetch, so we compare its *contents* — comparing identity would reset your
  // ticks on every poll of the event, mid-vote included.
  //
  // The rollback leans on a deferral recorded in `app/_layout.tsx`: with
  // `onlineManager` left unwired to NetInfo, an offline vote *rejects*. Wire it
  // and React Query's default `networkMode: 'online'` would **pause** the
  // mutation instead — `mutateAsync` never settles, so no catch, no rollback, no
  // message, and the airplane-mode case is the bug again.
  const serverVotes = poll.your_votes ?? [];
  const serverKey = voteKey(serverVotes);
  const [selected, setSelected] = useState<Set<number>>(() => new Set(serverVotes));
  const [syncedKey, setSyncedKey] = useState(serverKey);
  // A rejected vote: the selection it tried to cast, what the server held at the
  // time, and the message to show.
  const [voteError, setVoteError] = useState<
    { cast: string; from: string; message: string } | null
  >(null);
  if (syncedKey !== serverKey) {
    setSyncedKey(serverKey);
    setSelected(new Set(serverVotes));
  }
  // Clear the failure only once the server has *moved* to the very selection we
  // thought failed — the request landed and only its response was lost (#226),
  // so "your vote didn't go through" would now be sitting under a tick the
  // server has confirmed. Any other change to `your_votes` leaves the message
  // standing: it's about your attempt, not about whatever else has happened
  // since.
  //
  // Both halves are compared against keys recorded at the attempt, never against
  // when the sync arrives, so this holds even when the refetch and the rejection
  // land in the same React batch — the trap #231 describes, where a blanket
  // "clear on sync" swallowed the message before it was ever painted. `from` is
  // what keeps a re-cast of the server's own answer honest: attempting exactly
  // what the server already holds means `cast` equals `serverKey` already, and
  // without `from` the message would go the instant it was set.
  //
  // Same condition, for the same reason, as `RsvpBar` and the web's
  // `reactionFailures.js`.
  if (voteError && serverKey !== voteError.from && serverKey === voteError.cast) {
    setVoteError(null);
  }
  const [editing, setEditing] = useState(false);

  // Android back leaves the edit form rather than the event screen — the
  // hardware equivalent of its Cancel (#168), and held while the save is out
  // for the same reason its Cancel already is (#256).
  //
  // `editPoll` is the only poll mutation on the event screen with no
  // `onError: Alert.alert`, deliberately: it's `mutateAsync` so the form can
  // surface a 409 ("voting has started") *in place*, matching the web. Unmount
  // the form mid-save and that one message — the whole reason for the
  // `mutateAsync` handoff — is never spoken.
  const hold = useWriteHold();
  useAndroidBack(editing, () => {
    if (hold.held) return;
    setEditing(false);
  });

  async function toggle(optionId: number) {
    if (!open || busy) return;
    const before = selected;
    const next = new Set(poll.allow_multiple ? selected : []);
    if (selected.has(optionId)) next.delete(optionId);
    else next.add(optionId);
    setSelected(next);
    setVoteError(null);
    try {
      await onVote(Array.from(next));
    } catch (err) {
      // The vote didn't happen — put the tick back where it was and say so.
      // Leaving it showing is what makes a dropped answer invisible: the tally
      // not moving reads as "nobody else has voted", not "you never voted".
      //
      // Roll back only what we ourselves put there: if the sync above replaced
      // `next` while this request was in flight, the server has since spoken and
      // its answer must not be undone by a snapshot taken before the tap.
      setSelected((current) => (current === next ? before : current));
      // Only the server's own words are fit to show: an `ApiError` carries DRF's
      // `detail`, written for a person ("This poll is closed."). Everything else
      // is a runtime string, and offline is the very case this rollback exists
      // for, so it's the message a tester will hit first.
      //
      // `serverMessage`, not a bare `instanceof ApiError`: since #243 a lost
      // connection *is* an `ApiError` too — that's how it stopped being React
      // Native's `Network request failed` — so the class no longer separates the
      // server's words from our own stand-ins. The `fromServer` flag does.
      setVoteError({
        cast: voteKey(Array.from(next)),
        from: serverKey,
        message: serverMessage(err, 'Your vote didn’t go through — try again.'),
      });
    }
  }

  const { openMenu, menu } = useActionMenu();

  function showMenu() {
    // Four items for an unvoted poll. Through the old `Alert` fallback Android
    // kept only three and dropped **Cancel**, in a dialog that was also
    // non-cancelable — so every remaining button mutated the poll and there was
    // no way out. See the note in ActionMenu.tsx.
    openMenu({
      title: 'Poll options',
      items: [
        ...(canEdit
          ? [{ label: 'Edit poll', onPress: () => setEditing(true) }]
          : []),
        open
          ? { label: 'Close poll', onPress: () => onClose?.() }
          : { label: 'Re-open poll', onPress: () => onReopen?.() },
        { label: 'Remove poll', destructive: true, onPress: confirmRemove },
      ],
    });
  }

  function confirmRemove() {
    Alert.alert('Remove this poll?', 'The votes so far are discarded.', [
      { text: 'Keep it', style: 'cancel' },
      { text: 'Remove poll', style: 'destructive', onPress: () => onDelete?.() },
    ]);
  }

  if (editing) {
    return (
      <WriteHoldProvider hold={hold}>
        <PollEditForm poll={poll} onSave={onEdit} onDone={() => setEditing(false)} />
      </WriteHoldProvider>
    );
  }

  const noVotes = options.every((o) => (o.count || 0) === 0);

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.question}>{poll.question}</Text>
        <View style={styles.headRight}>
          <Text style={styles.status}>
            {open ? (poll.allow_multiple ? 'open · pick any' : 'open · pick one') : 'closed'}
          </Text>
          {canManage ? (
            <Pressable
              onPress={showMenu}
              accessibilityRole="button"
              accessibilityLabel="Poll options"
              hitSlop={8}
            >
              <Text style={styles.kebab}>⋯</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      <View style={styles.options}>
        {options.map((opt) => {
          const chosen = selected.has(opt.id);
          const pct = Math.round(((opt.count || 0) / max) * 100);
          // The finalise arg for this option, or null if it carries no value to
          // pin (unreachable for a well-formed poll — the button just hides).
          const finaliseArg = canManage && onFinalise ? finaliseFor(poll, opt) : null;
          return (
            <View key={opt.id}>
              <View style={styles.optionLine}>
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
                {finaliseArg ? (
                  <Pressable
                    onPress={() => onFinalise?.(finaliseArg)}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel={`${isCustom ? 'Pin' : 'Set'} ${optionLabel(poll, opt)}`}
                    style={({ pressed }) => [styles.pin, pressed && styles.pressed]}
                  >
                    <Text style={styles.pinLabel}>{isCustom ? 'Pin' : 'Set'}</Text>
                  </Pressable>
                ) : null}
              </View>
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

      {voteError ? (
        <Text style={styles.error} accessibilityRole="alert">
          {voteError.message}
        </Text>
      ) : null}

      {menu}
    </View>
  );
}

// Fix a poll's mistakes (organiser, only while unvoted): its options, pick-one vs
// pick-any, and — for a custom poll — its question. It's the create form
// pre-filled, sharing `PollOptionFields`. Built-in questions are auto-derived, so
// only custom shows the question field (a small mobile simplification — the API's
// `question` is optional, so a built-in edit just omits it).
function PollEditForm({
  poll,
  onSave,
  onDone,
}: {
  poll: Poll;
  onSave?: (payload: EditPollPayload) => Promise<unknown>;
  onDone: () => void;
}) {
  const dim = poll.dimension as PollDimension;
  const [question, setQuestion] = useState(poll.question ?? '');
  const [options, setOptions] = useState<OptionRow[]>(() =>
    (poll.options ?? []).map((o) => ({ key: String(o.id), id: o.id, value: optionEditValue(dim, o) }))
  );
  const [allowMultiple, setAllowMultiple] = useState(!!poll.allow_multiple);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The tally above owns Android's back; this is where the request is. Its own
  // Cancel was already gated on `saving`, which is what made the hardware
  // button look like an oversight rather than a decision (#256).
  useHoldOpen(saving);

  async function submit() {
    if (dim === 'custom' && !question.trim()) {
      setError('A poll needs a question.');
      return;
    }
    const filled = options.filter((o) => o.value.trim());
    if (filled.length < 2) {
      setError('A poll needs at least two options.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave?.({
        ...(dim === 'custom' ? { question: question.trim() } : {}),
        allowMultiple,
        // Keep the id on existing options (rewrite); a new one has none. Anything
        // cleared falls out here and the server drops it.
        options: filled.map((o) => ({
          ...(o.id ? { id: o.id } : {}),
          ...optionValuePayload(dim, o.value),
        })),
      });
      onDone();
    } catch (err) {
      setError(serverMessage(err, 'Couldn’t save your changes.'));
      setSaving(false);
    }
  }

  return (
    <View style={styles.card}>
      {dim === 'custom' ? (
        <TextInput
          style={styles.editInput}
          value={question}
          onChangeText={setQuestion}
          placeholder="Poll question"
          placeholderTextColor={colors.inkFaint}
          accessibilityLabel="Poll question"
        />
      ) : null}
      <PollOptionFields
        dimension={dim}
        options={options}
        onChange={setOptions}
        allowMultiple={allowMultiple}
        onAllowMultiple={setAllowMultiple}
        activeIndex={activeIndex}
        onActiveIndex={setActiveIndex}
      />
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      <View style={styles.editActions}>
        <Pressable
          onPress={submit}
          disabled={saving}
          accessibilityRole="button"
          style={({ pressed }) => [styles.save, (pressed || saving) && styles.pressed]}
        >
          <Text style={styles.saveLabel}>{saving ? 'Saving…' : 'Save changes'}</Text>
        </Pressable>
        <Pressable
          onPress={onDone}
          disabled={saving}
          accessibilityRole="button"
          style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}
        >
          <Text style={styles.cancelLabel}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** A stable, order-independent fingerprint of a vote list, so a refetch that
 *  returns the same votes in a different order isn't mistaken for a change. */
function voteKey(votes: number[]): string {
  return [...votes].sort((a, b) => a - b).join(',');
}

function optionLabel(poll: Poll, opt: PollResultOption): string {
  if (poll.dimension === 'date' && opt.date_value) return formatEventDate(opt.date_value);
  if (poll.dimension === 'time' && opt.time_value) return formatEventTime(opt.time_value);
  return opt.label;
}

/** Finalise arg for pinning a specific option — a value for a built-in, or the
 *  option id for a custom poll. `null` when a built-in option carries no value to
 *  pin (unreachable for a well-formed poll): the caller hides the button rather
 *  than finalising an empty value the server would reject. */
function finaliseFor(poll: Poll, opt: PollResultOption): FinaliseArg | null {
  if (poll.dimension === 'custom') return { dimension: 'custom', optionId: opt.id };
  if (poll.dimension === 'date') return opt.date_value ? { dimension: 'date', value: opt.date_value } : null;
  if (poll.dimension === 'time') return opt.time_value ? { dimension: 'time', value: opt.time_value } : null;
  const place = opt.text_value || opt.label;
  return place ? { dimension: 'location', value: place } : null;
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
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
  headRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  question: { fontSize: fontSize.base, fontWeight: '700', color: colors.ink, flexShrink: 1 },
  status: { fontSize: 11, color: colors.inkFaint },
  kebab: { fontSize: fontSize.lg, color: colors.inkFaint, fontWeight: '700' },
  options: { gap: spacing.sm },
  optionLine: { flexDirection: 'row', alignItems: 'stretch', gap: spacing.sm },
  optionRow: {
    flex: 1,
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
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: colors.accentTint },
  fillChosen: { backgroundColor: colors.accentTint },
  optionLabel: { fontFamily: fonts.mono, fontSize: fontSize.sm, color: colors.ink, flexShrink: 1 },
  optionCount: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.inkSoft,
    fontVariant: ['tabular-nums'],
  },
  pin: {
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  pinLabel: { fontSize: fontSize.sm, fontWeight: '600', color: colors.accentDeep },
  voters: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.xs, paddingLeft: spacing.xs },
  empty: { fontSize: fontSize.sm, color: colors.inkFaint },
  editInput: {
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: fontSize.sm,
    color: colors.ink,
  },
  error: { fontSize: fontSize.sm, color: colors.danger },
  editActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  save: {
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
  },
  saveLabel: { fontSize: fontSize.sm, fontWeight: '600', color: '#ffffff' },
  cancel: {
    borderWidth: 1,
    borderColor: colors.lineStrong,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
  },
  cancelLabel: { fontSize: fontSize.sm, fontWeight: '600', color: colors.ink },
  pressed: { opacity: 0.7 },
});
