import { useState } from "react";

// The one contextual editor that opens beneath the chip row when the organiser
// clicks Set or Poll on a chip. It already knows *which* dimension — the chip
// said so — so there's no dimension picker to wade through: you clicked "Date",
// you're setting or polling a date. `mode` is "set" (write a value directly) or
// "poll" (open an advisory poll the group votes on).
const NOUN = { date: "date", time: "time", location: "place", custom: "question" };
const INPUT_TYPE = { date: "date", time: "time", location: "text" };
const SET_VERB = { date: "Set the date", time: "Set the time", location: "Set the place" };
const PLACEHOLDER = { location: "e.g. The Oakhouse" };

export default function DimensionEditor({ dimension, mode, onSet, onPoll, onCancel, busy }) {
  return (
    <div className="ev-editor">
      {mode === "set" ? (
        <SetField dimension={dimension} onSet={onSet} onCancel={onCancel} busy={busy} />
      ) : (
        <PollBuilder dimension={dimension} onPoll={onPoll} onCancel={onCancel} busy={busy} />
      )}
    </div>
  );
}

function SetField({ dimension, onSet, onCancel, busy }) {
  const [value, setValue] = useState("");
  const type = INPUT_TYPE[dimension] || "text";
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onSet(dimension, value.trim());
      }}
    >
      <input
        type={type}
        value={value}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        placeholder={PLACEHOLDER[dimension]}
        aria-label={SET_VERB[dimension]}
        className="rounded-md border border-line-strong bg-raised px-2.5 py-1.5 text-sm"
      />
      <button type="submit" disabled={busy || !value.trim()} className="btn btn-primary btn-sm">
        {SET_VERB[dimension]}
      </button>
      <button type="button" onClick={onCancel} className="btn btn-ghost btn-sm">
        Cancel
      </button>
    </form>
  );
}

// Candidate options, typed to the dimension. Date/time use native pickers; a
// custom poll also names its question. At least two options to open.
function PollBuilder({ dimension, onPoll, onCancel, busy }) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const type = INPUT_TYPE[dimension] || "text";
  const filled = options.filter((v) => v.trim());
  const canOpen = filled.length >= 2 && (dimension !== "custom" || question.trim());

  function submit(e) {
    e.preventDefault();
    if (!canOpen) return;
    const built = filled.map((v) =>
      dimension === "date"
        ? { date_value: v }
        : dimension === "time"
          ? { time_value: v }
          : { text_value: v }
    );
    onPoll({
      dimension,
      question: dimension === "custom" ? question.trim() : undefined,
      options: built,
    });
  }

  return (
    <form onSubmit={submit}>
      <p className="mb-2 text-sm text-ink-soft">
        Give the group a few {dimension === "custom" ? "options" : `${NOUN[dimension]}s`}{" "}
        to choose from — you make the final call.
      </p>
      {dimension === "custom" && (
        <input
          type="text"
          value={question}
          autoFocus
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Your question — e.g. What should we bring?"
          className="mb-2 w-full rounded-md border border-line-strong bg-raised px-2.5 py-1.5 text-sm"
        />
      )}
      <div className="space-y-2">
        {options.map((opt, i) => (
          <input
            key={i}
            type={type}
            value={opt}
            autoFocus={dimension !== "custom" && i === 0}
            onChange={(e) => {
              const next = [...options];
              next[i] = e.target.value;
              setOptions(next);
            }}
            placeholder={type === "text" ? `Option ${i + 1}` : undefined}
            className="w-full max-w-xs rounded-md border border-line-strong bg-raised px-2.5 py-1.5 text-sm"
          />
        ))}
      </div>
      <button
        type="button"
        onClick={() => setOptions([...options, ""])}
        className="mt-2 text-sm font-medium text-accent-deep hover:underline"
      >
        + Add {NOUN[dimension] === "question" ? "option" : NOUN[dimension]}
      </button>
      <div className="mt-3 flex gap-2">
        <button type="submit" disabled={!canOpen || busy} className="btn btn-primary btn-sm">
          Open poll
        </button>
        <button type="button" onClick={onCancel} className="btn btn-ghost btn-sm">
          Cancel
        </button>
      </div>
    </form>
  );
}
