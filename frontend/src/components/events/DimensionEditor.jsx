import { useRef, useState } from "react";

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

// Date and time get segmented entries that hop to the next box after each part is
// filled (type "19" "07" "2026", or "10" "00", no reaching for Tab) — deterministic
// across browsers. Location is plain text. (Each branch is its own component so no
// hook is ever called conditionally.)
function SetField({ dimension, onSet, onCancel, busy }) {
  if (dimension === "time") {
    return <TimeSetField onSet={onSet} onCancel={onCancel} busy={busy} />;
  }
  if (dimension === "date") {
    return <DateSetField onSet={onSet} onCancel={onCancel} busy={busy} />;
  }
  return (
    <TextSetField dimension={dimension} onSet={onSet} onCancel={onCancel} busy={busy} />
  );
}

function TextSetField({ dimension, onSet, onCancel, busy }) {
  const [value, setValue] = useState("");
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onSet(dimension, value.trim());
      }}
    >
      <input
        type="text"
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

// A day/month/year entry (that order — British/AU, and the boxes are labelled so
// it's never ambiguous). Filling a box jumps to the next: "19" → "07" → "2026".
// The value handed up is always ISO "YYYY-MM-DD" (what the API expects); an
// impossible date (31 Feb) leaves the button disabled.
function DateSetField({ onSet, onCancel, busy }) {
  const [dd, setDd] = useState("");
  const [mm, setMm] = useState("");
  const [yy, setYy] = useState("");
  const monthRef = useRef(null);
  const yearRef = useRef(null);

  function changeDay(e) {
    const v = e.target.value.replace(/\D/g, "").slice(0, 2);
    setDd(v);
    if (v.length === 2) monthRef.current?.focus();
  }
  function changeMonth(e) {
    const v = e.target.value.replace(/\D/g, "").slice(0, 2);
    setMm(v);
    if (v.length === 2) yearRef.current?.focus();
  }

  const d = Number(dd);
  const m = Number(mm);
  const y = Number(yy);
  const valid = yy.length === 4 && isRealDate(y, m, d);

  const boxInput =
    "w-7 bg-transparent text-center font-mono text-sm outline-none";

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) {
          onSet(
            "date",
            `${yy}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
          );
        }
      }}
    >
      <span className="inline-flex items-center gap-1 rounded-md border border-line-strong bg-raised px-2 py-1.5">
        <input
          inputMode="numeric"
          value={dd}
          onChange={changeDay}
          maxLength={2}
          autoFocus
          aria-label="Day"
          placeholder="DD"
          className={boxInput}
        />
        <span className="text-ink-faint">/</span>
        <input
          ref={monthRef}
          inputMode="numeric"
          value={mm}
          onChange={changeMonth}
          maxLength={2}
          aria-label="Month"
          placeholder="MM"
          className={boxInput}
        />
        <span className="text-ink-faint">/</span>
        <input
          ref={yearRef}
          inputMode="numeric"
          value={yy}
          onChange={(e) => setYy(e.target.value.replace(/\D/g, "").slice(0, 4))}
          maxLength={4}
          aria-label="Year"
          placeholder="YYYY"
          className="w-12 bg-transparent text-center font-mono text-sm outline-none"
        />
      </span>
      <button type="submit" disabled={busy || !valid} className="btn btn-primary btn-sm">
        Set the date
      </button>
      <button type="button" onClick={onCancel} className="btn btn-ghost btn-sm">
        Cancel
      </button>
    </form>
  );
}

// True only for a real calendar date — rejects 31 Feb etc. by round-tripping.
function isRealDate(y, m, d) {
  if (!y || !m || !d) return false;
  const dt = new Date(y, m - 1, d);
  return (
    dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
  );
}

// A 24-hour HH:MM entry. Typing two digits in the hour box jumps focus to the
// minute box, so "10" then "00" sets 10:00 with no reaching for Tab. Digits only;
// the value handed up is always zero-padded "HH:MM" (what the API expects).
function TimeSetField({ onSet, onCancel, busy }) {
  const [hh, setHh] = useState("");
  const [mm, setMm] = useState("");
  const minuteRef = useRef(null);

  function changeHour(e) {
    const v = e.target.value.replace(/\D/g, "").slice(0, 2);
    setHh(v);
    if (v.length === 2) minuteRef.current?.focus();
  }

  const h = Number(hh);
  const m = Number(mm);
  const valid =
    hh.length > 0 && mm.length > 0 && h >= 0 && h < 24 && m >= 0 && m < 60;

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) {
          onSet(
            "time",
            `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
          );
        }
      }}
    >
      <span className="inline-flex items-center gap-1 rounded-md border border-line-strong bg-raised px-2 py-1.5">
        <input
          inputMode="numeric"
          value={hh}
          onChange={changeHour}
          maxLength={2}
          autoFocus
          aria-label="Hour"
          placeholder="HH"
          className="w-7 bg-transparent text-center font-mono text-sm outline-none"
        />
        <span className="text-ink-faint">:</span>
        <input
          ref={minuteRef}
          inputMode="numeric"
          value={mm}
          onChange={(e) => setMm(e.target.value.replace(/\D/g, "").slice(0, 2))}
          maxLength={2}
          aria-label="Minute"
          placeholder="MM"
          className="w-7 bg-transparent text-center font-mono text-sm outline-none"
        />
      </span>
      <span className="text-xs text-ink-faint">24-hour</span>
      <button type="submit" disabled={busy || !valid} className="btn btn-primary btn-sm">
        Set the time
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
