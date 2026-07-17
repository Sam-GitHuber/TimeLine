import { Link } from "react-router-dom";
import Avatar from "../Avatar.jsx";
import DimensionChips from "./DimensionChips.jsx";
import { formatEventWhen } from "../../utils.js";

// One event as a summary card, linking to its detail page. Three render
// branches on the *same* row (never a separate model):
//   - a live planning/scheduled event → the dimension chip row + turnout,
//   - a past event → a quiet "recap" card (it's become a memory),
//   - a cancelled event → a tombstone.
// `showGroup` labels the event with its group (the personal calendar wants it;
// a single group's own list doesn't).
export default function EventCard({ event, showGroup = false }) {
  const to = `/g/${event.group.id}/events/${event.id}`;
  const cancelled = event.status === "cancelled";
  const past = event.is_past;
  const going = event.rsvp?.counts?.going || 0;

  if (past && !cancelled) {
    return (
      <Link to={to} className="ev-card ev-recap block">
        <div className="flex items-center gap-2 text-xs text-ink-faint">
          <span className="ev-tag">Event · happened</span>
          {showGroup && <GroupLabel event={event} />}
        </div>
        <p className="mt-1 font-display text-base font-semibold text-ink-soft">
          {event.title}
        </p>
        <p className="mt-0.5 font-mono text-sm text-ink-faint">
          {formatEventWhen(event)}
          {event.location_name ? ` · ${event.location_name}` : ""}
        </p>
        <p className="mt-1 text-sm text-ink-faint">
          {going > 0 ? `${going} went` : "no turnout recorded"}
        </p>
      </Link>
    );
  }

  return (
    <Link
      to={to}
      className={`ev-card block ${cancelled ? "ev-cancelled" : ""}`}
    >
      <div className="flex items-start gap-3">
        <Avatar user={event.organiser} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-display text-lg font-semibold text-ink">
              {event.title}
            </h3>
            {cancelled && <span className="ev-tag ev-tag--off">Cancelled</span>}
            {showGroup && <GroupLabel event={event} />}
          </div>
          <p className="text-sm text-ink-faint">
            {event.organiser.display_name}
            {event.event_date ? ` · ${formatEventWhen(event)}` : " · being planned"}
          </p>
          {event.description && (
            <p className="mt-1 line-clamp-2 text-sm text-ink-soft">
              {event.description}
            </p>
          )}
          <div className="mt-3">
            <DimensionChips event={event} />
          </div>
          {going > 0 && (
            <p className="mt-2 text-xs text-ink-faint">
              {going} going
              {event.rsvp?.counts?.maybe
                ? ` · ${event.rsvp.counts.maybe} maybe`
                : ""}
            </p>
          )}
        </div>
      </div>
    </Link>
  );
}

function GroupLabel({ event }) {
  return (
    <span className="text-xs text-ink-faint">
      · <span className="italic">{event.group.name}</span>
    </span>
  );
}
