import { Link } from "react-router-dom";
import Avatar from "../Avatar.jsx";
import DimensionChips from "./DimensionChips.jsx";
import {
  parseEventDate,
  formatEventWhen,
  formatClockTime,
} from "../../utils.js";

// An event as an entry on the timeline spine — the same shape as a post (a marker
// on the line, mono type on the rail, the organiser + content in the body), so an
// event reads as part of the one continuous line whether it's ahead of now or
// behind it. `variant` decides which:
//
// - "future" (above the now-node): the date sits on the rail in accent, and the
//   body carries the live details — description, the dimension chips, RSVP counts.
// - "past"   (below the now-node, among the posts): a quiet **recap**. The rail
//   shows the clock time like a post (the day divider already gives the date), and
//   the body drops the planning chips for a one-line mono recap + the turnout —
//   the event has become a memory, not a thing to act on.
//
// A cancelled event is dimmed and tagged in either direction.
export default function EventTimelineEntry({ event, variant = "future" }) {
  const past = variant === "past";
  const cancelled = event.status === "cancelled";
  const going = event.rsvp?.counts?.going || 0;
  const maybe = event.rsvp?.counts?.maybe || 0;

  return (
    <article
      className={`tl-entry tl-entry--event ${past ? "tl-entry--event-past" : ""} ${
        cancelled ? "tl-entry--off" : ""
      }`}
    >
      <div className="tl-rail">
        <span className="tl-avatar-node">
          <Avatar user={event.organiser} size="xs" />
        </span>
        <Rail event={event} past={past} />
      </div>

      <div className="tl-body">
        <div className="flex flex-wrap items-baseline gap-x-1.5">
          {past && !cancelled && <span className="ev-tag ev-tag--muted">Happened</span>}
          <Link
            to={`/g/${event.group.id}/events/${event.id}`}
            className={`font-semibold transition hover:text-accent-deep ${
              past ? "text-ink-soft" : "text-ink"
            }`}
          >
            {event.title}
          </Link>
          {cancelled && <span className="ev-tag ev-tag--off">Cancelled</span>}
        </div>

        <p className="text-sm text-ink-faint">
          {event.organiser.display_name}
          {" · "}
          <span className="font-mono">{formatEventWhen(event)}</span>
          {event.location_name ? ` · ${event.location_name}` : ""}
        </p>

        {!past && event.description && (
          <p className="mt-1 line-clamp-2 text-sm text-ink-soft">
            {event.description}
          </p>
        )}

        {/* The Date · Time · Where pills stay on a past event too — the recap
            shows what it settled on, just as the future entry shows what's set. */}
        <div className="mt-2">
          <DimensionChips event={event} />
        </div>

        {past
          ? going > 0 && (
              <p className="mt-1 text-xs text-ink-faint">{going} went</p>
            )
          : (going > 0 || maybe > 0) && (
              <p className="mt-2 text-xs text-ink-faint">
                {going} going{maybe > 0 ? ` · ${maybe} maybe` : ""}
              </p>
            )}
      </div>
    </article>
  );
}

// The rail voice-of-time: a past event shows its clock time like a post (the day
// divider carries the date); a future event shows its date (there are no day
// dividers above now) in accent.
function Rail({ event, past }) {
  if (past) {
    if (event.start_time && event.starts_at) {
      const { time, meridiem } = formatClockTime(event.starts_at);
      return (
        <time
          className="font-mono text-xs tabular-nums text-ink-faint"
          dateTime={event.starts_at}
        >
          {time}
          <br />
          {meridiem}
        </time>
      );
    }
    return (
      <span className="font-mono text-xs text-ink-faint">
        all
        <br />
        day
      </span>
    );
  }

  const d = parseEventDate(event.event_date);
  return (
    <time
      className="font-mono text-xs tabular-nums text-accent-deep"
      dateTime={event.event_date}
    >
      {d ? d.getDate() : ""}
      <br />
      {d ? d.toLocaleDateString(undefined, { month: "short" }) : ""}
    </time>
  );
}
