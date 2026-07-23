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
 * E3c-a covers **set** only (finalise a value directly). The **poll** builder is
 * E3c-b — this component grows a `mode`/poll branch then, mirroring the web
 * `DimensionEditor`. Ported (set side) from
 * `frontend/src/components/events/DimensionEditor.jsx`.
 */

import DateTimePicker, {
  type DateTimePickerEvent,
} from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, fontSize, radius, spacing } from '@/theme';

type Dimension = 'date' | 'time' | 'location';

const SET_VERB: Record<Dimension, string> = {
  date: 'Set the date',
  time: 'Set the time',
  location: 'Set the place',
};

export function DimensionEditor({
  dimension,
  onSet,
  onCancel,
  busy = false,
}: {
  dimension: Dimension;
  /** Hands up the ISO value: `YYYY-MM-DD` (date), `HH:MM` (time), or free text. */
  onSet: (dimension: Dimension, value: string) => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  return (
    <View style={styles.editor}>
      {dimension === 'location' ? (
        <LocationField onSet={onSet} onCancel={onCancel} busy={busy} />
      ) : (
        <DateTimeField dimension={dimension} onSet={onSet} onCancel={onCancel} busy={busy} />
      )}
    </View>
  );
}

function LocationField({
  onSet,
  onCancel,
  busy,
}: {
  onSet: (dimension: Dimension, value: string) => void;
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
        onSet={() => onSet('location', trimmed)}
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
  onSet: (dimension: Dimension, value: string) => void;
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

  return (
    <View style={styles.column}>
      <DateTimePicker
        value={value}
        mode={dimension}
        display="spinner"
        onChange={onChange}
      />
      <Actions
        label={SET_VERB[dimension]}
        disabled={busy}
        onSet={() =>
          onSet(dimension, dimension === 'date' ? toISODate(value) : toHM(value))
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
