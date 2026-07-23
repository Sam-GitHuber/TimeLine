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
 * **The organiser (`canManage`, E3c-b) also gets the lifecycle:** a **Set/Pin**
 * on each option (finalise it — the tally informs, the organiser decides; there
 * is deliberately no automatic winner), and a **⋯ menu** with Edit (only while
 * unvoted — a cast vote locks the wording, mirrored by the server's 409) / Close
 * or Re-open / Remove. Ported from `frontend/src/components/events/PollTally.jsx`.
 */

import { useState } from 'react';
import {
  ActionSheetIOS,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Avatar } from '../Avatar';
import { PollOptionFields } from './PollOptionFields';
import {
  optionEditValue,
  optionValuePayload,
  type OptionRow,
  type PollDimension,
} from './pollOptions';
import { formatEventDate, formatEventTime } from '@/eventFormat';
import { colors, fontSize, fonts, radius, spacing } from '@/theme';
import type { Poll, PollOptionPayload, PollResultOption } from '@/types';

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
  onVote: (optionIds: number[]) => void;
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

  // Seeded once from the server, then owned locally (no prop→state sync effect,
  // which React flags) — same as the web. A cast refetches for fresh *counts*.
  const [selected, setSelected] = useState<Set<number>>(new Set(poll.your_votes ?? []));
  const [editing, setEditing] = useState(false);

  function toggle(optionId: number) {
    if (!open || busy) return;
    const next = new Set(poll.allow_multiple ? selected : []);
    if (selected.has(optionId)) next.delete(optionId);
    else next.add(optionId);
    setSelected(next);
    onVote(Array.from(next));
  }

  function openMenu() {
    const labels = [
      ...(canEdit ? ['Edit poll'] : []),
      open ? 'Close poll' : 'Re-open poll',
      'Remove poll',
      'Cancel',
    ];
    const cancelIndex = labels.length - 1;
    const removeIndex = labels.indexOf('Remove poll');
    const run = (i: number) => {
      const label = labels[i];
      if (label === 'Edit poll') setEditing(true);
      else if (label === 'Close poll') onClose?.();
      else if (label === 'Re-open poll') onReopen?.();
      else if (label === 'Remove poll') confirmRemove();
    };
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: labels, destructiveButtonIndex: removeIndex, cancelButtonIndex: cancelIndex },
        run
      );
    } else {
      Alert.alert('Poll options', undefined, [
        ...labels.slice(0, cancelIndex).map((label, i) => ({
          text: label,
          onPress: () => run(i),
          style: (label === 'Remove poll' ? 'destructive' : 'default') as 'destructive' | 'default',
        })),
        { text: 'Cancel', style: 'cancel' as const },
      ]);
    }
  }

  function confirmRemove() {
    Alert.alert('Remove this poll?', 'The votes so far are discarded.', [
      { text: 'Keep it', style: 'cancel' },
      { text: 'Remove poll', style: 'destructive', onPress: () => onDelete?.() },
    ]);
  }

  if (editing) {
    return (
      <PollEditForm poll={poll} onSave={onEdit} onDone={() => setEditing(false)} />
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
              onPress={openMenu}
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
      setError(err instanceof Error ? err.message : 'Couldn’t save your changes.');
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
