/**
 * The contextual editor that opens beneath the chip row when the organiser taps
 * **Set** (or **Change**) on a built-in dimension. It already knows *which*
 * dimension — the chip said so — so there's no picker to wade through.
 *
 * **Native adaptation, per the E3 plan** (docs/phases/phase-9-iphone-app.md):
 * date and time use the **OS date/time picker** (`@react-native-community/
 * datetimepicker`) rather than a port of the web's segmented DD/MM/YYYY boxes —
 * the wheel/calendar is what a phone user expects, and it hands the API the same
 * ISO `YYYY-MM-DD` / `HH:MM`. Location is plain text (an organiser-typed place).
 *
 * `mode` is **set** (finalise a value directly, built-ins only) or **poll** (open
 * an advisory poll the group votes on — E3c-b, for any dimension incl. custom).
 * Ported from `frontend/src/components/events/DimensionEditor.jsx`.
 */

import DateTimePicker, {
  type DateTimePickerEvent,
} from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, fontSize, pickerHeight, pickerThemeVariant, radius, spacing } from '@/theme';
import { PollOptionFields } from './PollOptionFields';
import {
  blankOption,
  OPTION_NOUN,
  optionValuePayload,
  type OptionRow,
  type PollDimension,
} from './pollOptions';
import type { PollOptionPayload } from '@/types';

type BuiltinDim = 'date' | 'time' | 'location';

const SET_VERB: Record<BuiltinDim, string> = {
  date: 'Set the date',
  time: 'Set the time',
  location: 'Set the place',
};

/** What the poll builder hands up — the shape `api.openPoll` takes. */
export type PollDraft = {
  dimension: PollDimension;
  question?: string;
  allowMultiple: boolean;
  options: PollOptionPayload[];
};

export function DimensionEditor({
  dimension,
  mode,
  onSet,
  onPoll,
  onCancel,
  busy = false,
}: {
  dimension: PollDimension;
  mode: 'set' | 'poll';
  /** Set mode: the ISO value — `YYYY-MM-DD` / `HH:MM` / free text. */
  onSet?: (dimension: BuiltinDim, value: string) => void;
  /** Poll mode: the drafted poll. */
  onPoll?: (draft: PollDraft) => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  return (
    <View style={styles.editor}>
      {mode === 'poll' ? (
        <PollBuilder dimension={dimension} onPoll={onPoll} onCancel={onCancel} busy={busy} />
      ) : dimension === 'location' ? (
        <LocationField onSet={onSet} onCancel={onCancel} busy={busy} />
      ) : (
        // Set mode is built-ins only; 'custom' never reaches here (no direct value).
        <DateTimeField dimension={dimension as 'date' | 'time'} onSet={onSet} onCancel={onCancel} busy={busy} />
      )}
    </View>
  );
}

// Candidate options typed to the dimension, plus (for custom) the question.
// At least two filled options to open; you make the final call regardless.
function PollBuilder({
  dimension,
  onPoll,
  onCancel,
  busy,
}: {
  dimension: PollDimension;
  onPoll?: (draft: PollDraft) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<OptionRow[]>(() => [blankOption(), blankOption()]);
  // Seed pick-one/any from the same per-dimension default the server would apply
  // (date/time → pick any, location/custom → pick one); the organiser can override.
  const [allowMultiple, setAllowMultiple] = useState(dimension === 'date' || dimension === 'time');
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const filled = options.filter((o) => o.value.trim());
  const canOpen = filled.length >= 2 && (dimension !== 'custom' || question.trim().length > 0);
  const noun = dimension === 'custom' ? 'options' : `${OPTION_NOUN[dimension]}s`;

  function submit() {
    if (!canOpen) return;
    onPoll?.({
      dimension,
      question: dimension === 'custom' ? question.trim() : undefined,
      allowMultiple,
      options: filled.map((o) => optionValuePayload(dimension, o.value)),
    });
  }

  return (
    <View style={{ gap: spacing.sm }}>
      <Text style={styles.hint}>
        Give the group a few {noun} to choose from — you make the final call.
      </Text>
      {dimension === 'custom' ? (
        <TextInput
          style={styles.input}
          value={question}
          onChangeText={setQuestion}
          placeholder="Your question — e.g. What should we bring?"
          placeholderTextColor={colors.inkFaint}
          accessibilityLabel="Poll question"
          autoFocus
        />
      ) : null}
      <PollOptionFields
        dimension={dimension}
        options={options}
        onChange={setOptions}
        allowMultiple={allowMultiple}
        onAllowMultiple={setAllowMultiple}
        activeIndex={activeIndex}
        onActiveIndex={setActiveIndex}
      />
      <Actions
        label="Open poll"
        disabled={busy || !canOpen}
        onSet={submit}
        onCancel={onCancel}
      />
    </View>
  );
}

function LocationField({
  onSet,
  onCancel,
  busy,
}: {
  onSet?: (dimension: BuiltinDim, value: string) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [value, setValue] = useState('');
  const trimmed = value.trim();
  return (
    <View style={styles.row}>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={setValue}
        placeholder="e.g. The Oakhouse"
        placeholderTextColor={colors.inkFaint}
        accessibilityLabel="Set the place"
        autoFocus
        editable={!busy}
      />
      <Actions
        label={SET_VERB.location}
        disabled={busy || !trimmed}
        onSet={() => onSet?.('location', trimmed)}
        onCancel={onCancel}
      />
    </View>
  );
}

function DateTimeField({
  dimension,
  onSet,
  onCancel,
  busy,
}: {
  dimension: 'date' | 'time';
  onSet?: (dimension: BuiltinDim, value: string) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  // Seed to now; the picker shows today / this hour selected until the organiser
  // spins it. The value handed up is derived from the picked `Date`'s *local*
  // wall-clock parts (never `toISOString`, which is UTC and can slip a day).
  const [value, setValue] = useState(() => new Date());

  const onChange = (_event: DateTimePickerEvent, picked?: Date) => {
    if (picked) setValue(picked);
  };

  // iOS renders the spinner inline and persistently, which is what this layout
  // assumes. Android's picker is a one-shot modal dialog: an always-mounted
  // instance shows once and won't reopen after dismissal, so Phase 10 (Android)
  // will need a `show` state + remount around this. iOS-only for now.
  return (
    <View style={styles.column}>
      <DateTimePicker
        value={value}
        mode={dimension}
        display="spinner"
        // `styles.picker` / `pickerThemeVariant` carry the two picker quirks
        // (explicit size, forced light wheel) — see theme.ts.
        style={styles.picker}
        themeVariant={pickerThemeVariant}
        onChange={onChange}
      />
      <Actions
        label={SET_VERB[dimension]}
        disabled={busy}
        onSet={() =>
          onSet?.(dimension, dimension === 'date' ? toISODate(value) : toHM(value))
        }
        onCancel={onCancel}
      />
    </View>
  );
}

function Actions({
  label,
  disabled,
  onSet,
  onCancel,
}: {
  label: string;
  disabled: boolean;
  onSet: () => void;
  onCancel: () => void;
}) {
  return (
    <View style={styles.actions}>
      <Pressable
        onPress={onSet}
        disabled={disabled}
        accessibilityRole="button"
        style={({ pressed }) => [
          styles.btn,
          styles.primary,
          (pressed || disabled) && styles.pressed,
        ]}
      >
        <Text style={styles.primaryLabel}>{label}</Text>
      </Pressable>
      <Pressable
        onPress={onCancel}
        accessibilityRole="button"
        style={({ pressed }) => [styles.btn, styles.ghost, pressed && styles.pressed]}
      >
        <Text style={styles.ghostLabel}>Cancel</Text>
      </Pressable>
    </View>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');
function toISODate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function toHM(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const styles = StyleSheet.create({
  editor: {
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.raised,
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  column: { gap: spacing.sm, alignItems: 'flex-start' },
  picker: { alignSelf: 'stretch', height: pickerHeight },
  hint: { fontSize: fontSize.sm, color: colors.inkSoft, lineHeight: 20 },
  input: {
    flexGrow: 1,
    minWidth: 160,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: fontSize.sm,
    color: colors.ink,
  },
  actions: { flexDirection: 'row', gap: spacing.sm },
  btn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primary: { backgroundColor: colors.accent },
  primaryLabel: { fontSize: fontSize.sm, fontWeight: '600', color: '#ffffff' },
  ghost: { borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.raised },
  ghostLabel: { fontSize: fontSize.sm, fontWeight: '600', color: colors.ink },
  pressed: { opacity: 0.7 },
});
