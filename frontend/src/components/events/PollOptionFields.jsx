// The shared middle of both poll forms — opening a poll (DimensionEditor's
// PollBuilder) and editing one (PollTally's PollEditForm). Both want the same
// thing: a list of candidate options typed to the dimension, an "+ Add" to grow
// it, and the pick-one vs pick-any checkbox. Editing is just the create form
// pre-filled, so it shares this component (and the value helpers below) rather
// than keeping a second copy.
//
// `options` is a controlled list of `{ key, id?, value }` — `key` is a stable
// React key, `id` is present only for options that already exist on the server
// (so an edit can rewrite vs. add), and `value` is the raw input string. The
// parent owns validation and submission. Pure helpers live in ./pollOptions.js.
import { pollInputType, blankOption } from "./pollOptions.js";

const NOUN = { date: "date", time: "time", location: "place", custom: "question" };

export default function PollOptionFields({
  dimension,
  options,
  onChange,
  allowMultiple,
  onAllowMultiple,
  autoFocusFirst = false,
}) {
  const type = pollInputType(dimension);
  const noun = NOUN[dimension];

  function setValue(i, value) {
    const next = options.slice();
    next[i] = { ...next[i], value };
    onChange(next);
  }

  return (
    <>
      <div className="space-y-2">
        {options.map((opt, i) => (
          <input
            key={opt.key}
            type={type}
            value={opt.value}
            autoFocus={autoFocusFirst && i === 0}
            onChange={(e) => setValue(i, e.target.value)}
            placeholder={type === "text" ? `Option ${i + 1}` : undefined}
            aria-label={`Option ${i + 1}`}
            className="w-full max-w-xs rounded-md border border-line-strong bg-raised px-2.5 py-1.5 text-sm"
          />
        ))}
      </div>
      <button
        type="button"
        onClick={() => onChange([...options, blankOption()])}
        className="mt-2 text-sm font-medium text-accent-deep hover:underline"
      >
        + Add {noun === "question" ? "option" : noun}
      </button>
      <label className="mt-3 flex items-center gap-2 text-sm text-ink-soft">
        <input
          type="checkbox"
          checked={allowMultiple}
          onChange={(e) => onAllowMultiple(e.target.checked)}
          className="h-4 w-4 rounded border-line-strong text-accent-deep focus:ring-accent"
        />
        Let people pick more than one
      </label>
    </>
  );
}
