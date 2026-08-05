// Pure helpers shared by the poll forms (PollOptionFields, and its two callers
// PollBuilder + PollEditForm). Kept out of the component file so that stays
// component-only (React Fast Refresh).

// The everyday word for one option of a dimension — used in prompts ("a few
// dates") and the "+ Add place" affordance.
export const OPTION_NOUN = {
  date: "date",
  time: "time",
  location: "place",
  custom: "question",
};

// What we say when a **finalise** is refused and the server wrote nothing
// readable of its own. Per state, not generic — knowing *which* decision didn't
// happen is most of the value (connections.md, "Reporting a refused write").
// Shared because the same `finaliseEvent` is reachable from two places: the chip
// row's `DimensionEditor`, and a poll's Set/Pin and free-value box in
// `PollTally`. One map so the two can't drift into saying different things about
// the same refused write.
export const FINALISE_FALLBACK = {
  date: "Couldn't set the date — try again.",
  time: "Couldn't set the time — try again.",
  location: "Couldn't set the place — try again.",
  custom: "Couldn't pin that answer — try again.",
};

// The <input> type for a dimension's option values.
export function pollInputType(dimension) {
  return dimension === "date" ? "date" : dimension === "time" ? "time" : "text";
}

// A raw input string → the typed API field for the poll's dimension. Shared so
// create and edit build option payloads identically.
export function optionValuePayload(dimension, value) {
  const v = String(value).trim();
  if (dimension === "date") return { date_value: v };
  if (dimension === "time") return { time_value: v };
  return { text_value: v };
}

// A fresh, empty option row with a stable React key (ids come from the server,
// so new rows need their own unique keys).
let keySeq = 0;
export function blankOption() {
  return { key: `new-${keySeq++}`, value: "" };
}
