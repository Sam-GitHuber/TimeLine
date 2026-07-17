import { useEffect, useRef, useState } from "react";
import Avatar from "../Avatar.jsx";
import { formatEventDate, formatEventTime } from "../../utils.js";

// A poll's tally — a Doodle/when2meet feel without the coldness: each candidate
// option is a row with a bar that fills as votes arrive and a full count on the
// right. The count is **complete** across the whole audience (decision 2); the
// avatar chips are only your connections (everyone else folds into the count).
//
// A member sees a Vote affordance while the poll is open. The organiser also
// gets a **finalise** control on any option — or a free value — plus a ⋯ menu
// that gathers the poll's lifecycle actions (edit / close / re-open / remove).
// There is deliberately no automatic "winner": the tally informs, the organiser
// decides. Copy: "Set the date", never "close poll → winner wins".
export default function PollTally({
  poll,
  canManage,
  onVote,
  onFinalise,
  onEdit,
  onClose,
  onReopen,
  onDelete,
  busy,
}) {
  const [selected, setSelected] = useState(new Set(poll.your_votes || []));
  const [editing, setEditing] = useState(false);
  const open = poll.status === "open";
  const options = poll.options || [];
  const max = Math.max(1, ...options.map((o) => o.count || 0));
  const isCustom = poll.dimension === "custom";
  // A poll locks its wording the moment the first vote lands (issue #87): a cast
  // vote can never be silently redefined. The count is complete, so this is the
  // honest signal. The server enforces the same guard with a 409.
  const canEdit = canManage && (poll.vote_count || 0) === 0;

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

  if (editing) {
    return (
      <PollEditForm
        poll={poll}
        onSave={onEdit}
        onDone={() => setEditing(false)}
      />
    );
  }

  return (
    <div className="ev-tally rounded-xl border border-line bg-raised p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="font-display text-base font-semibold text-ink">
          {poll.question}
        </h4>
        <div className="flex shrink-0 items-center gap-1">
          <span className="text-xs text-ink-faint">
            {open ? "open" : "closed"}
            {poll.allow_multiple && open ? " · pick any" : ""}
          </span>
          {canManage && (
            <PollMenu
              open={open}
              canEdit={canEdit}
              busy={busy}
              onEdit={() => setEditing(true)}
              onClose={onClose}
              onReopen={onReopen}
              onDelete={onDelete}
            />
          )}
        </div>
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

      {canManage && !isCustom && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <FreeValueFinalise
            dimension={poll.dimension}
            onFinalise={onFinalise}
            busy={busy}
          />
        </div>
      )}
    </div>
  );
}

// The poll's lifecycle actions behind a single ⋯ (issue #87). Edit only appears
// while the poll has no votes — once voting starts the wording is locked, and we
// say so in place. Close/Re-open mirror the poll's open state; Remove is last.
// Self-contained absolute dropdown (no portal): the poll card doesn't clip, and
// this matches the GroupActionsMenu convention — click-outside / Escape close,
// arrow keys to move between items.
function PollMenu({ open, canEdit, busy, onEdit, onClose, onReopen, onDelete }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const triggerRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    }
    function onKeyDown(e) {
      if (e.key === "Escape") {
        setMenuOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const items = listRef.current?.querySelectorAll('[role="menuitem"]');
    items?.[0]?.focus();
  }, [menuOpen]);

  function onMenuKeyDown(e) {
    const items = Array.from(
      listRef.current?.querySelectorAll('[role="menuitem"]') ?? []
    );
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement);
    let next = null;
    if (e.key === "ArrowDown") next = items[(i + 1) % items.length];
    else if (e.key === "ArrowUp") next = items[(i - 1 + items.length) % items.length];
    else if (e.key === "Home") next = items[0];
    else if (e.key === "End") next = items[items.length - 1];
    if (!next) return;
    e.preventDefault();
    next.focus();
  }

  function run(action) {
    setMenuOpen(false);
    action?.();
  }

  const itemClass =
    "block w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-ink-soft transition hover:bg-accent-tint hover:text-accent-deep disabled:opacity-50";
  const dangerClass =
    "block w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-50";

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setMenuOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="Poll options"
        className={`flex h-8 w-8 items-center justify-center rounded-full text-ink-faint transition hover:bg-accent-tint hover:text-accent-deep ${
          menuOpen ? "bg-accent-tint text-accent-deep" : ""
        }`}
      >
        <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <circle cx="10" cy="4" r="1.6" />
          <circle cx="10" cy="10" r="1.6" />
          <circle cx="10" cy="16" r="1.6" />
        </svg>
      </button>

      {menuOpen && (
        <div
          role="menu"
          ref={listRef}
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 top-full z-20 mt-2 w-48 overflow-hidden rounded-xl border border-line bg-raised p-1 shadow-lg"
        >
          {canEdit ? (
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => run(onEdit)}
              className={itemClass}
            >
              Edit poll
            </button>
          ) : (
            <p className="px-3 py-2 text-xs text-ink-faint">
              Wording locks once voting starts.
            </p>
          )}
          {open ? (
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => run(onClose)}
              className={itemClass}
            >
              Close poll
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => run(onReopen)}
              className={itemClass}
            >
              Re-open poll
            </button>
          )}
          <div className="my-1 border-t border-line" />
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => run(onDelete)}
            className={dangerClass}
          >
            Remove poll
          </button>
        </div>
      )}
    </div>
  );
}

// Fix a poll's mistakes (issue #87): edit the question and each option's value —
// a date/time picker for date/time polls, free text for location/custom — the
// same inputs used to create the poll. Only reachable while the poll has no
// votes (the wording is frozen the moment someone votes). Adding or removing
// options isn't offered; this rewrites the existing set.
function PollEditForm({ poll, onSave, onDone }) {
  const [question, setQuestion] = useState(poll.question || "");
  const dim = poll.dimension;
  const [opts, setOpts] = useState(() =>
    (poll.options || []).map((o) => ({ id: o.id, value: optionEditValue(dim, o) }))
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const inputType = dim === "date" ? "date" : dim === "time" ? "time" : "text";

  function setOpt(i, value) {
    const next = opts.slice();
    next[i] = { ...next[i], value };
    setOpts(next);
  }

  async function submit(e) {
    e.preventDefault();
    const q = question.trim();
    if (!q) {
      setError("A poll needs a question.");
      return;
    }
    if (opts.some((o) => !String(o.value).trim())) {
      setError("Every option needs a value.");
      return;
    }
    const payload = { question: q, options: opts.map((o) => optionEditPayload(dim, o)) };
    setSaving(true);
    setError(null);
    try {
      await onSave(payload);
      onDone();
    } catch (err) {
      setError(err?.message || "Couldn't save your changes.");
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="ev-tally rounded-xl border border-line bg-raised p-4"
    >
      <label className="block text-xs font-medium text-ink-faint">Question</label>
      <input
        type="text"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        className="mt-1 w-full rounded-md border border-line-strong bg-raised px-2 py-1 text-sm"
        aria-label="Poll question"
      />

      <div className="mt-3 space-y-2">
        <span className="block text-xs font-medium text-ink-faint">Options</span>
        {opts.map((o, i) => (
          <input
            key={o.id}
            type={inputType}
            value={o.value}
            onChange={(e) => setOpt(i, e.target.value)}
            className="w-full rounded-md border border-line-strong bg-raised px-2 py-1 font-mono text-sm"
            aria-label={`Option ${i + 1}`}
          />
        ))}
      </div>

      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      )}

      <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
        <button type="submit" disabled={saving} className="btn btn-primary btn-sm">
          {saving ? "Saving…" : "Save changes"}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={onDone}
          className="btn btn-ghost btn-sm"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// The raw editable value for an option, per dimension: an ISO date / HH:MM time
// (what the <input> wants), or the free text for location/custom.
function optionEditValue(dim, opt) {
  if (dim === "date") return opt.date_value || "";
  if (dim === "time") return (opt.time_value || "").slice(0, 5);
  return opt.text_value || opt.label || "";
}

// Turn an edited option back into the API's typed field for the dimension.
function optionEditPayload(dim, o) {
  const value = String(o.value).trim();
  if (dim === "date") return { id: o.id, date_value: value };
  if (dim === "time") return { id: o.id, time_value: value };
  return { id: o.id, text_value: value };
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
