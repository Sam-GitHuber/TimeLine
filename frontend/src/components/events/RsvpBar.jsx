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
  const cancelled = event.status === "cancelled";

  // Guests and note are yours to type, but the server owns the answer:
  // `your_response` changes underneath this component whenever the event
  // refetches, and every RSVP/vote/finalise on the page ends in an invalidate
  // while the page stays mounted. Seeded once, the two inputs kept a stale
  // answer next to a "+ N guests" summary read from the fresh payload — and
  // pressing Update then posted the stale number back, silently reverting an
  // RSVP made on another device (issue #229). So they're re-derived whenever
  // the server's answer *changes*, compared by contents: a refetch hands back a
  // fresh object every time, and comparing identity would wipe what you're
  // half-way through typing on every poll of the event.
  const serverKey = rsvpKey(mine);
  const [guests, setGuests] = useState(mine?.guests || 0);
  const [note, setNote] = useState(mine?.note || "");
  const [syncedKey, setSyncedKey] = useState(serverKey);
  // A rejected RSVP, tagged with the answer it tried to save.
  const [failed, setFailed] = useState(null);
  if (syncedKey !== serverKey) {
    setSyncedKey(serverKey);
    setGuests(mine?.guests || 0);
    setNote(mine?.note || "");
  }
  // Clear the failure only once the server has *moved* to the very answer we
  // thought failed — the request landed and only its response was lost, so
  // "didn't save" would now be sitting under an answer that did. Any other
  // change to `your_response` leaves the message standing: it's about your
  // attempt, not about whatever else has happened since.
  //
  // Both halves are compared against keys recorded at the attempt, never
  // against when the sync arrives, so this holds even when the refetch and the
  // rejection land in the same render batch — the trap #231 describes, where a
  // blanket "clear on sync" swallows the message before it is ever painted.
  // `from` is what makes an unchanged Update honest too: re-pressing it without
  // editing anything means `saved` already equals the server's answer, and
  // without `from` the message would be cleared the instant it was set.
  if (failed && serverKey !== failed.from && serverKey === failed.saved) {
    setFailed(null);
  }

  // Your typed values stay put on a rejection — the message, not a snap-back,
  // is what tells you it didn't save, and pressing Update again retries without
  // retyping the note.
  async function submit(body) {
    if (cancelled) return;
    setFailed(null);
    try {
      await onRsvp(body);
    } catch (err) {
      // Without this the failure is silent: the fields keep your text as if it
      // had saved, and the count simply not moving reads as "nobody else has
      // RSVP'd yet" rather than "your change was rejected".
      setFailed({
        saved: rsvpKey(body),
        from: serverKey,
        message: err?.message || "Your RSVP didn't save — try again.",
      });
    }
  }

  function choose(response) {
    submit({ response, guests, note });
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
            submit({ response: "going", guests, note });
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

      {failed && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {failed.message}
        </p>
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

// A fingerprint of an RSVP answer — the server's `your_response` or a body we
// tried to save — so the two can be compared by contents rather than identity.
function rsvpKey(r) {
  if (!r) return "";
  return `${r.response}|${r.guests || 0}|${r.note || ""}`;
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
