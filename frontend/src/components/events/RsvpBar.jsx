import { useState } from "react";
import Avatar from "../Avatar.jsx";

// The RSVP control + summary. Counts are **complete** across the whole audience
// (decision 2); the named avatar lists are **connection-gated** — you see who's
// going only among your own connections, everyone else adds to the count as an
// anonymous +1. One RSVP per person, upserted.
const RESPONSES = [
  { key: "going", label: "Going" },
  { key: "maybe", label: "Maybe" },
  { key: "declined", label: "Can't go" },
];

export default function RsvpBar({ event, onRsvp, busy }) {
  const rsvp = event.rsvp || {};
  const mine = rsvp.your_response || null;
  const counts = rsvp.counts || { going: 0, maybe: 0, declined: 0, guests: 0 };
  const [guests, setGuests] = useState(mine?.guests || 0);
  const [note, setNote] = useState(mine?.note || "");
  const cancelled = event.status === "cancelled";

  function choose(response) {
    if (cancelled) return;
    onRsvp({ response, guests, note });
  }

  return (
    <div className="ev-rsvp">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Your RSVP">
        {RESPONSES.map((r) => {
          const active = mine?.response === r.key;
          return (
            <button
              key={r.key}
              type="button"
              disabled={busy || cancelled}
              onClick={() => choose(r.key)}
              aria-pressed={active}
              className={`btn btn-sm ${active ? "btn-primary" : "btn-ghost"}`}
            >
              {r.label}
              <span className="ml-1.5 font-mono text-xs opacity-80">
                {counts[r.key] || 0}
              </span>
            </button>
          );
        })}
      </div>

      {mine?.response === "going" && !cancelled && (
        <form
          className="mt-2 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            onRsvp({ response: "going", guests, note });
          }}
        >
          <label className="text-sm text-ink-soft">
            Bringing guests?
            <input
              type="number"
              min="0"
              max="50"
              value={guests}
              onChange={(e) => setGuests(Number(e.target.value))}
              className="ml-2 w-16 rounded-md border border-line-strong bg-raised px-2 py-1 text-sm"
            />
          </label>
          <label className="flex-1 text-sm text-ink-soft">
            Note
            <input
              type="text"
              value={note}
              maxLength={200}
              onChange={(e) => setNote(e.target.value)}
              placeholder="optional — e.g. running 10 min late"
              className="ml-2 w-full max-w-xs rounded-md border border-line-strong bg-raised px-2 py-1 text-sm"
            />
          </label>
          <button type="submit" disabled={busy} className="btn btn-ghost btn-sm">
            Update
          </button>
        </form>
      )}

      {counts.guests > 0 && (
        <p className="mt-1 text-xs text-ink-faint">
          + {counts.guests} guest{counts.guests === 1 ? "" : "s"}
        </p>
      )}

      <NamedList title="Going" people={rsvp.going_list} />
      <NamedList title="Maybe" people={rsvp.maybe_list} />
    </div>
  );
}

function NamedList({ title, people }) {
  if (!people || people.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-xs font-medium text-ink-faint">{title}:</span>
      {people.map((p) => (
        <span key={p.id} className="inline-flex items-center gap-1" title={p.display_name}>
          <Avatar user={p} size="xs" />
        </span>
      ))}
    </div>
  );
}
