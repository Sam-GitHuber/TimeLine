/**
 * The shared middle of both poll forms — opening a poll (the builder in
 * `DimensionEditor`) and editing one (`PollTally`'s edit form): a list of
 * candidate options **typed to the dimension**, an "+ Add" to grow it, and the
 * pick-one vs pick-any switch. Editing is the create form pre-filled, so both
 * share this. Ported from `frontend/src/components/events/PollOptionFields.jsx`.
 *
 * **Native adaptation:** date/time options use the OS picker (tap a row → a
 * picker drops in beneath it → the row shows the chosen value), where the web
 * uses `<input type=date|time>`. Location/custom options are plain text rows.
 */

import DateTimePicker, {
  type DateTimePickerChangeEvent,
} from '@react-native-community/datetimepicker';
import { Platform, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { formatEventDate, formatEventTime } from '@/eventFormat';
import { colors, fontSize, fonts, pickerHeight, pickerThemeVariant, radius, spacing } from '@/theme';
import {
  blankOption,
  OPTION_NOUN,
  pickedToValue,
  type OptionRow,
  type PollDimension,
} from './pollOptions';

export function PollOptionFields({
  dimension,
  options,
  onChange,
  allowMultiple,
  onAllowMultiple,
  /** Index of the row whose date/time picker is open, or null. */
  activeIndex,
  onActiveIndex,
}: {
  dimension: PollDimension;
  options: OptionRow[];
  onChange: (options: OptionRow[]) => void;
  allowMultiple: boolean;
  onAllowMultiple: (value: boolean) => void;
  activeIndex: number | null;
  onActiveIndex: (index: number | null) => void;
}) {
  const noun = OPTION_NOUN[dimension];
  const isPicker = dimension === 'date' || dimension === 'time';

  const setValue = (i: number, value: string) => {
    const next = options.slice();
    next[i] = { ...next[i], value };
    onChange(next);
  };

  const addRow = () => onChange([...options, blankOption()]);

  // The date/time picker is a persistent inline wheel on iOS and a one-shot
  // modal dialog on Android; see the comment at the picker below.
  const isAndroid = Platform.OS === 'android';

  return (
    <View style={styles.wrap}>
      <View style={styles.list}>
        {options.map((opt, i) => (
          <View key={opt.key}>
            {isPicker ? (
              <Pressable
                onPress={() => onActiveIndex(activeIndex === i ? null : i)}
                accessibilityRole="button"
                accessibilityLabel={`Option ${i + 1}`}
                style={styles.pickerRow}
              >
                <Text style={[styles.pickerValue, !opt.value && styles.placeholder]}>
                  {opt.value
                    ? dimension === 'date'
                      ? formatEventDate(opt.value)
                      : formatEventTime(opt.value)
                    : `Pick a ${noun}`}
                </Text>
              </Pressable>
            ) : (
              <TextInput
                style={styles.input}
                value={opt.value}
                onChangeText={(v) => setValue(i, v)}
                placeholder={`Option ${i + 1}`}
                placeholderTextColor={colors.inkFaint}
                accessibilityLabel={`Option ${i + 1}`}
                editable
              />
            )}
            {isPicker && activeIndex === i ? (
              // iOS: keep the spinner open while it's the active row — its
              // `onChange` fires on *every* tick, so closing there (the first
              // bug) dismissed it the instant you touched it. Update the value
              // live; a "Done" (or tapping another row) collapses it.
              //
              // Android: the same mount opens a modal dialog, which reports
              // once and is then inert. So it closes the row on either
              // `onValueChange` (OK) or `onDismiss` (Cancel) — unmounting, so
              // the next press gets a working instance — and draws no "Done",
              // because the dialog brings its own OK/Cancel.
              <View style={styles.pickerOpen}>
                <DateTimePicker
                  value={valueToDate(dimension, opt.value)}
                  mode={dimension}
                  display={isAndroid ? 'default' : 'spinner'}
                  // `styles.picker` / `pickerThemeVariant` carry the two *iOS*
                  // picker quirks (explicit size, forced light wheel) — see
                  // theme.ts. Neither applies to a system dialog.
                  style={isAndroid ? undefined : styles.picker}
                  themeVariant={isAndroid ? undefined : pickerThemeVariant}
                  onValueChange={(
                    _e: DateTimePickerChangeEvent,
                    picked: Date
                  ) => {
                    if (isAndroid) onActiveIndex(null);
                    setValue(i, pickedToValue(dimension, picked));
                  }}
                  // Android's Cancel. Never fires for the iOS inline wheel,
                  // which is never dismissed, so it needs no platform guard.
                  onDismiss={() => onActiveIndex(null)}
                />
                {isAndroid ? null : (
                  <Pressable
                    onPress={() => onActiveIndex(null)}
                    accessibilityRole="button"
                    accessibilityLabel="Done"
                    hitSlop={6}
                    style={styles.done}
                  >
                    <Text style={styles.doneLabel}>Done</Text>
                  </Pressable>
                )}
              </View>
            ) : null}
          </View>
        ))}
      </View>

      <Pressable onPress={addRow} accessibilityRole="button" hitSlop={6} style={styles.add}>
        <Text style={styles.addLabel}>+ Add {noun === 'question' ? 'option' : noun}</Text>
      </Pressable>

      <View style={styles.multi}>
        <Switch
          value={allowMultiple}
          onValueChange={onAllowMultiple}
          accessibilityLabel="Let people pick more than one"
        />
        <Text style={styles.multiLabel}>Let people pick more than one</Text>
      </View>
    </View>
  );
}

/** Seed the picker from the row's current value, or now if it's blank. */
function valueToDate(dimension: 'date' | 'time', value: string): Date {
  if (!value) return new Date();
  if (dimension === 'date') {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  }
  const [h, min] = value.split(':').map(Number);
  const d = new Date();
  d.setHours(h || 0, min || 0, 0, 0);
  return d;
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs },
  list: { gap: spacing.xs },
  input: {
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.md,
    backgroundColor: colors.raised,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: fontSize.sm,
    color: colors.ink,
  },
  pickerRow: {
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.md,
    backgroundColor: colors.raised,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  pickerValue: { fontFamily: fonts.mono, fontSize: fontSize.sm, color: colors.ink },
  placeholder: { fontFamily: undefined, color: colors.inkFaint },
  pickerOpen: { alignSelf: 'stretch' },
  picker: { alignSelf: 'stretch', height: pickerHeight },
  done: {
    alignSelf: 'flex-end',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  doneLabel: { fontSize: fontSize.sm, fontWeight: '700', color: colors.accentDeep },
  add: { paddingVertical: spacing.xs, alignSelf: 'flex-start' },
  addLabel: { fontSize: fontSize.sm, fontWeight: '700', color: colors.accentDeep },
  multi: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.xs },
  multiLabel: { fontSize: fontSize.sm, color: colors.inkSoft, flexShrink: 1 },
});
