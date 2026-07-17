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
