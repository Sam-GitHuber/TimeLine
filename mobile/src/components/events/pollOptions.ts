/**
 * Pure helpers shared by the poll forms (`PollOptionFields`, and its callers the
 * poll builder in `DimensionEditor` + the edit form in `PollTally`). Ported from
 * `frontend/src/components/events/pollOptions.js` — keep the two in sync.
 */

import type { PollOptionPayload } from '@/types';

export type PollDimension = 'date' | 'time' | 'location' | 'custom';

/** A working option row: a stable key, the raw value, and an id if it exists. */
export type OptionRow = { key: string; id?: number; value: string };

/** The everyday word for one option of a dimension — used in prompts + "Add …". */
export const OPTION_NOUN: Record<PollDimension, string> = {
  date: 'date',
  time: 'time',
  location: 'place',
  custom: 'question',
};

/** A raw value → the typed API field for the poll's dimension. */
export function optionValuePayload(dimension: PollDimension, value: string): PollOptionPayload {
  const v = value.trim();
  if (dimension === 'date') return { date_value: v };
  if (dimension === 'time') return { time_value: v };
  return { text_value: v };
}

/** The raw editable value of an existing option, per dimension. */
export function optionEditValue(
  dimension: PollDimension,
  opt: { date_value: string | null; time_value: string | null; text_value: string | null; label: string }
): string {
  if (dimension === 'date') return opt.date_value ?? '';
  if (dimension === 'time') return (opt.time_value ?? '').slice(0, 5);
  return opt.text_value ?? opt.label ?? '';
}

// New rows need their own unique React keys (server ids only exist post-save).
let keySeq = 0;
export function blankOption(): OptionRow {
  return { key: `new-${keySeq++}`, value: '' };
}

/**
 * A `Date` from the native picker → the ISO value the API wants, from its
 * **local** wall-clock parts (never `toISOString`, which is UTC and can slip a
 * day). Date → `YYYY-MM-DD`; time → `HH:MM`.
 */
export function pickedToValue(dimension: 'date' | 'time', d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return dimension === 'date'
    ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
