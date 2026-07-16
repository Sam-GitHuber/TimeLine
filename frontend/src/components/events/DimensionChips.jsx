import { formatEventDate, formatEventTime } from "../../utils.js";

// The signature element (Phase 8b): a row of decision chips — Date · Time ·
// Where (+ any custom) — each rendering its own state so an event's readiness is
// legible at a glance, AND doubling as the organiser's control surface. The
// organiser "lights chips up in any order": an unset chip offers Set · Poll right
// on it; a set chip shows the value in mono with a quiet Change; a polling chip
// shows a live tally and jumps to the poll below.
//
// Read-only when `canManage` is false (members, and the summary cards): the chips
// are then a glanceable status, with no actions.
const LABELS = { date: "Date", time: "Time", location: "Where" };

export default function DimensionChips({ event, canManage = false, onAction }) {
  const dims = event.dimensions || {};
  const polls = event.polls || [];

  const builtins = ["date", "time", "location"].map((key) => ({
    key,
    dim: key,
    label: LABELS[key],
    state: dims[key]?.state || "unset",
    value: dimensionValue(event, key),
    pollId: dims[key]?.poll,
    total: pollTotal(polls, dims[key]?.poll),
  }));

  // One extra chip per custom poll (e.g. "What to bring?"). Custom decisions are
  // pinned from the poll tally, so these chips are display + jump only.
  const customs = polls
    .filter((p) => p.dimension === "custom")
    .map((p) => ({
      key: `custom-${p.id}`,
      dim: null,
      label: p.question,
      state: p.decided_option ? "set" : p.status === "open" ? "polling" : "unset",
      value: decidedLabel(p),
      pollId: p.status === "open" ? p.id : null,
      total: pollTotal(polls, p.id),
    }));

  return (
    <ul className="ev-chips" aria-label="Event details">
      {[...builtins, ...customs].map((chip) => (
        <Chip key={chip.key} chip={chip} canManage={canManage} onAction={onAction} />
      ))}
    </ul>
  );
}

function Chip({ chip, canManage, onAction }) {
  const { dim, label, state, value, pollId, total } = chip;
  const act = (mode) => onAction && onAction(dim, mode, pollId);

  if (state === "polling") {
    const tally = total === 1 ? "1 vote" : `${total} votes`;
    // Interactive (on the event page) → a button that jumps to the poll. Read-only
    // (a summary card, which is itself a link) → plain text, never a nested button.
    if (onAction) {
      return (
        <li className="ev-chip ev-chip--polling">
          <button type="button" className="ev-chip-hit" onClick={() => act("goto")}>
            <span className="ev-chip-label">{label}</span>
            <span className="ev-chip-value">{tally}</span>
            <span className="ev-chip-arrow" aria-hidden="true">→</span>
          </button>
        </li>
      );
    }
    return (
      <li className="ev-chip ev-chip--polling">
        <span className="ev-chip-label">{label}</span>
        <span className="ev-chip-value">{tally}</span>
      </li>
    );
  }

  if (state === "set") {
    return (
      <li className="ev-chip ev-chip--set">
        <span className="ev-chip-label">{label}</span>
        {value && <span className="ev-chip-value font-mono">{value}</span>}
        {canManage && dim && (
          <button type="button" className="ev-chip-btn" onClick={() => act("set")}>
            Change
          </button>
        )}
      </li>
    );
  }

  // unset — for the organiser this is the start of the sequential-polling flow.
  return (
    <li className="ev-chip ev-chip--unset">
      <span className="ev-chip-label">{label}</span>
      {canManage && dim ? (
        <span className="ev-chip-actions">
          <button type="button" className="ev-chip-btn" onClick={() => act("set")}>
            Set
          </button>
          <span className="ev-chip-sep" aria-hidden="true">·</span>
          <button type="button" className="ev-chip-btn" onClick={() => act("poll")}>
            Poll
          </button>
        </span>
      ) : (
        <span className="ev-chip-value">not set</span>
      )}
    </li>
  );
}

function dimensionValue(event, key) {
  if (key === "date") return formatEventDate(event.event_date);
  if (key === "location") return event.location_name;
  // time (with an optional end)
  const start = formatEventTime(event.start_time);
  if (!start) return "";
  const end = formatEventTime(event.end_time);
  return end ? `${start}–${end}` : start;
}

function decidedLabel(poll) {
  if (!poll.decided_option) return "";
  const opt = (poll.options || []).find((o) => o.id === poll.decided_option);
  return opt ? opt.label : "";
}

function pollTotal(polls, pollId) {
  if (!pollId) return 0;
  const poll = polls.find((p) => p.id === pollId);
  if (!poll) return 0;
  return (poll.options || []).reduce((sum, o) => sum + (o.count || 0), 0);
}
