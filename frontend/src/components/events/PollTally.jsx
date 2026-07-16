import { useState } from "react";
import Avatar from "../Avatar.jsx";
import { formatEventDate, formatEventTime } from "../../utils.js";

// A poll's tally — a Doodle/when2meet feel without the coldness: each candidate
// option is a row with a bar that fills as votes arrive and a full count on the
// right. The count is **complete** across the whole audience (decision 2); the
// avatar chips are only your connections (everyone else folds into the count).
//
// A member sees a Vote affordance while the poll is open. The organiser also
// gets a **finalise** control on any option — or a free value — plus Close.
// There is deliberately no automatic "winner": the tally informs, the organiser
// decides. Copy: "Set the date", never "close poll → winner wins".
export default function PollTally({
  poll,
  canManage,
  onVote,
  onFinalise,
  onClose,
  onDelete,
  busy,
}) {
  const [selected, setSelected] = useState(new Set(poll.your_votes || []));
  const open = poll.status === "open";
  const options = poll.options || [];
  const max = Math.max(1, ...options.map((o) => o.count || 0));
  const isCustom = poll.dimension === "custom";

  function toggle(optionId) {
    if (!open) return;
    const next = new Set(poll.allow_multiple ? selected : []);
    if (selected.has(optionId) && poll.allow_multiple) next.delete(optionId);
    else next.add(optionId);
    // A single-choice re-click on the same option clears it.
    if (!poll.allow_multiple && selected.has(optionId)) next.clear();
    setSelected(next);
    onVote(Array.from(next));
  }

  return (
    <div className="ev-tally rounded-xl border border-line bg-raised p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="font-display text-base font-semibold text-ink">
          {poll.question}
        </h4>
        <span className="text-xs text-ink-faint">
          {open ? "open" : "closed"}
          {poll.allow_multiple && open ? " · pick any" : ""}
        </span>
      </div>

      <ul className="mt-3 space-y-2">
        {options.map((opt) => {
          const chosen = selected.has(opt.id);
          const pct = Math.round(((opt.count || 0) / max) * 100);
          return (
            <li key={opt.id}>
              <div className="flex items-stretch gap-2">
                <button
                  type="button"
                  disabled={!open || busy}
                  onClick={() => toggle(opt.id)}
                  aria-pressed={chosen}
                  className={`ev-tally-row ${chosen ? "ev-tally-row--chosen" : ""}`}
                >
                  <span className="ev-tally-fill" style={{ width: `${pct}%` }} />
                  <span className="ev-tally-label font-mono">
                    {optionLabel(poll, opt)}
                  </span>
                  <span className="ev-tally-count">{opt.count || 0}</span>
                </button>
                {canManage && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => finaliseOption(poll, opt, onFinalise)}
                    className="btn btn-ghost btn-sm shrink-0"
                    title="Make this the decision"
                  >
                    {isCustom ? "Pin" : "Set"}
                  </button>
                )}
              </div>
              {opt.voters && opt.voters.length > 0 && (
                <div className="mt-1 flex flex-wrap items-center gap-1 pl-1">
                  {opt.voters.map((v) => (
                    <span key={v.id} title={v.display_name}>
                      <Avatar user={v} size="xs" />
                    </span>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {options.every((o) => (o.count || 0) === 0) && (
        <p className="mt-2 text-sm text-ink-faint">No votes yet.</p>
      )}

      {canManage && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
          {!isCustom && (
            <FreeValueFinalise
              dimension={poll.dimension}
              onFinalise={onFinalise}
              busy={busy}
            />
          )}
          {open && (
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="btn btn-ghost btn-sm"
            >
              Close poll
            </button>
          )}
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            className="btn btn-ghost btn-sm text-red-600"
          >
            Remove poll
          </button>
        </div>
      )}
    </div>
  );
}

// The organiser can set a value no one voted for (decision 3) — a small typed
// input beside the option list ("actually, let's do Friday").
function FreeValueFinalise({ dimension, onFinalise, busy }) {
  const [value, setValue] = useState("");
  const type = dimension === "date" ? "date" : dimension === "time" ? "time" : "text";
  const label =
    dimension === "date"
      ? "Set the date"
      : dimension === "time"
        ? "Set the time"
        : "Set the place";
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!value.trim()) return;
        onFinalise(dimension, { value: value.trim() });
        setValue("");
      }}
    >
      <input
        type={type}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={type === "text" ? "somewhere else…" : undefined}
        className="rounded-md border border-line-strong bg-raised px-2 py-1 text-sm"
        aria-label={label}
      />
      <button type="submit" disabled={busy || !value.trim()} className="btn btn-primary btn-sm">
        {label}
      </button>
    </form>
  );
}

function optionLabel(poll, opt) {
  if (poll.dimension === "date" && opt.date_value)
    return formatEventDate(opt.date_value);
  if (poll.dimension === "time" && opt.time_value)
    return formatEventTime(opt.time_value);
  return opt.label;
}

function finaliseOption(poll, opt, onFinalise) {
  if (poll.dimension === "custom") {
    onFinalise("custom", { optionId: opt.id });
    return;
  }
  if (poll.dimension === "date") onFinalise("date", { value: opt.date_value });
  else if (poll.dimension === "time")
    onFinalise("time", { value: opt.time_value });
  else onFinalise("location", { value: opt.text_value || opt.label });
}
