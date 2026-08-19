import { useState } from "react";
import Avatar from "../Avatar.jsx";
import {
  useDropdownMenu,
  menuItemClass,
  menuDangerItemClass,
} from "../useDropdownMenu.js";
import PollOptionFields from "./PollOptionFields.jsx";
import { optionValuePayload, FINALISE_FALLBACK } from "./pollOptions.js";
import { serverMessage } from "../../errors.js";
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
  // Your ticks are optimistic — they appear the moment you click, before the
  // server has agreed. Two things keep that from turning into a lie (issue
  // #216): `toggle` rolls them back if the request fails, and the server's
  // answer wins whenever it changes underneath us (you voted on your phone with
  // this page open, or your own vote round-tripped). `serverVotes` is a fresh
  // array on every refetch, so we compare its *contents* — comparing identity
  // would reset your ticks on every poll of the event, mid-vote included.
  const serverVotes = poll.your_votes || [];
  const serverKey = voteKey(serverVotes);
  const [selected, setSelected] = useState(() => new Set(serverVotes));
  const [syncedKey, setSyncedKey] = useState(serverKey);
  // A rejected vote: the selection it tried to cast, what the server held at the
  // time, and the message to show.
  const [voteError, setVoteError] = useState(null);
  if (syncedKey !== serverKey) {
    setSyncedKey(serverKey);
    setSelected(new Set(serverVotes));
  }
  // Clear the failure only once the server has *moved* to the very selection we
  // thought failed — the request landed and only its response was lost (issue
  // #226), so "your vote didn't go through" would now be sitting under a tick
  // the server has confirmed. Any other change to `your_votes` leaves the
  // message standing: it's about your attempt, not about whatever else has
  // happened since.
  //
  // Both halves are compared against keys recorded at the attempt, never against
  // when the sync arrives, so this holds even when the refetch and the rejection
  // land in the same render batch — the trap issue #231 describes, where a
  // blanket "clear on sync" swallowed the message before it was ever painted.
  // `from` is what keeps a re-cast of the server's own answer honest: attempting
  // exactly what the server already holds means `cast` equals `serverKey`
  // already, and without `from` the message would go the instant it was set.
  //
  // Same condition, for the same reason, as `RsvpBar` and `reactionFailures.js`.
  if (voteError && serverKey !== voteError.from && serverKey === voteError.cast) {
    setVoteError(null);
  }
  // The organiser's lifecycle actions and the per-option Set/Pin. Each is handed
  // down as `mutateAsync` so its rejection reaches the card the button is on —
  // before #237 they had `onSuccess: invalidate` and nothing else, so a close
  // that 404'd (another admin removed the poll) left it painted open with no
  // message, and votes went on arriving into a poll the organiser had frozen.
  //
  // Kept apart from `voteError` on purpose: that one is retired by the server
  // confirming the very vote it was about (#226), and a refetch triggered by
  // some *other* write on this page is no answer at all to "did my Remove poll
  // go through?".
  //
  // Returns whether the write landed, which is how `FreeValueFinalise` knows to
  // keep what you typed rather than clearing a value that never got set.
  const [actionError, setActionError] = useState(null);
  async function runAction(action, fallback) {
    if (!action) return false;
    setActionError(null);
    try {
      await action();
      return true;
    } catch (err) {
      setActionError(serverMessage(err, fallback));
      return false;
    }
  }
  // Which of the four things Set/Pin does didn't happen is most of the value, so
  // the fallback names it rather than saying "something went wrong". Keyed off
  // the dimension being finalised, not the poll's, since the free-value box on a
  // date poll still finalises a date.
  const runFinalise = (dimension, opts) =>
    runAction(
      () => onFinalise(dimension, opts),
      FINALISE_FALLBACK[dimension] || "That didn't work — try again."
    );

  const [editing, setEditing] = useState(false);
  const open = poll.status === "open";
  const options = poll.options || [];
  const max = Math.max(1, ...options.map((o) => o.count || 0));
  const isCustom = poll.dimension === "custom";
  // A poll locks its wording the moment the first vote lands (issue #87): a cast
  // vote can never be silently redefined. The count is complete, so this is the
  // honest signal. The server enforces the same guard with a 409.
  const canEdit = canManage && (poll.vote_count || 0) === 0;

  async function toggle(optionId) {
    if (!open) return;
    const before = selected;
    const next = new Set(poll.allow_multiple ? selected : []);
    if (selected.has(optionId) && poll.allow_multiple) next.delete(optionId);
    else next.add(optionId);
    // A single-choice re-click on the same option clears it.
    if (!poll.allow_multiple && selected.has(optionId)) next.clear();
    setSelected(next);
    setVoteError(null);
    try {
      await onVote(Array.from(next));
    } catch (err) {
      // The vote didn't happen — put the tick back where it was and say so.
      // Leaving it showing is what makes a dropped answer invisible: the tally
      // not moving reads as "nobody else has voted", not "you never voted".
      //
      // Roll back only what we ourselves put there: if the sync above replaced
      // `next` while this request was in flight, the server has since spoken and
      // its answer must not be undone by a snapshot taken before the click.
      setSelected((current) => (current === next ? before : current));
      setVoteError({
        cast: voteKey(Array.from(next)),
        from: serverKey,
        message: serverMessage(err, "Your vote didn't go through — try again."),
      });
    }
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
            {open ? (poll.allow_multiple ? " · pick any" : " · pick one") : ""}
          </span>
          {canManage && (
            <PollMenu
              open={open}
              canEdit={canEdit}
              busy={busy}
              onEdit={() => setEditing(true)}
              onClose={() =>
                runAction(onClose, "Couldn't close the poll — try again.")
              }
              onReopen={() =>
                runAction(onReopen, "Couldn't re-open the poll — try again.")
              }
              onDelete={() =>
                runAction(onDelete, "Couldn't remove the poll — try again.")
              }
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
                    onClick={() => finaliseOption(poll, opt, runFinalise)}
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

      {voteError && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {voteError.message}
        </p>
      )}

      {actionError && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {actionError}
        </p>
      )}

      {canManage && !isCustom && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <FreeValueFinalise
            dimension={poll.dimension}
            onFinalise={runFinalise}
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
// Self-contained absolute dropdown (no portal): the poll card doesn't clip. The
// open/close/keyboard wiring is the shared `useDropdownMenu` (same behaviour as
// the nav and group menus).
function PollMenu({ open, canEdit, busy, onEdit, onClose, onReopen, onDelete }) {
  const { open: menuOpen, setOpen, menuRef, triggerRef, listRef, onMenuKeyDown } =
    useDropdownMenu();

  function run(action) {
    setOpen(false);
    action?.();
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
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
              className={menuItemClass}
            >
              Edit poll
            </button>
          ) : (
            // A hint, not a choice — role="none" keeps it out of the menu's
            // item semantics (a role="menu" should contain only menuitems).
            <p role="none" className="px-3 py-2 text-xs text-ink-faint">
              Editing locks once voting starts.
            </p>
          )}
          {open ? (
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => run(onClose)}
              className={menuItemClass}
            >
              Close poll
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => run(onReopen)}
              className={menuItemClass}
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
            className={menuDangerItemClass}
          >
            Remove poll
          </button>
        </div>
      )}
    </div>
  );
}

// Fix a poll's mistakes (issue #87): edit the question, the options (change a
// value, add one, or drop one by clearing it), and pick-one vs pick-any. It's
// literally the create form pre-filled — the option list and its "+ Add" come
// from the shared PollOptionFields. Only reachable while the poll has no votes,
// so reconciling the option set can never redefine or orphan a cast vote.
function PollEditForm({ poll, onSave, onDone }) {
  const dim = poll.dimension;
  const [question, setQuestion] = useState(poll.question || "");
  const [options, setOptions] = useState(() =>
    (poll.options || []).map((o) => ({
      key: String(o.id),
      id: o.id,
      value: optionEditValue(dim, o),
    }))
  );
  const [allowMultiple, setAllowMultiple] = useState(!!poll.allow_multiple);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    const q = question.trim();
    if (!q) {
      setError("A poll needs a question.");
      return;
    }
    const filled = options.filter((o) => String(o.value).trim());
    if (filled.length < 2) {
      setError("A poll needs at least two options.");
      return;
    }
    const payload = {
      question: q,
      allowMultiple,
      // Keep the id on options that already exist (rewrite); a new option has
      // none (create). Anything the maker cleared falls out here and the server
      // drops it.
      options: filled.map((o) => ({
        ...(o.id ? { id: o.id } : {}),
        ...optionValuePayload(dim, o.value),
      })),
    };
    setSaving(true);
    setError(null);
    try {
      await onSave(payload);
      onDone();
    } catch (err) {
      setError(serverMessage(err, "Couldn't save your changes."));
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
        className="mb-3 mt-1 w-full rounded-md border border-line-strong bg-raised px-2 py-1 text-sm"
        aria-label="Poll question"
      />

      <PollOptionFields
        dimension={dim}
        options={options}
        onChange={setOptions}
        allowMultiple={allowMultiple}
        onAllowMultiple={setAllowMultiple}
      />

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
      onSubmit={async (e) => {
        e.preventDefault();
        if (!value.trim()) return;
        // Only clear once it's actually set — otherwise a rejected finalise
        // wipes the value you typed at the same moment it tells you it failed,
        // and the retry means typing it again.
        if (await onFinalise(dimension, { value: value.trim() })) setValue("");
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

// A stable, order-independent fingerprint of a vote list, so a refetch that
// returns the same votes in a different order isn't mistaken for a change.
function voteKey(votes) {
  return [...votes].sort((a, b) => a - b).join(",");
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
