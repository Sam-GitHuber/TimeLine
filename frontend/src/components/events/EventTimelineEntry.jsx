import { Link } from "react-router-dom";
import Avatar from "../Avatar.jsx";
import DimensionChips from "./DimensionChips.jsx";
import { parseEventDate, formatEventWhen } from "../../utils.js";

// An upcoming event as an entry on the timeline spine — the same shape as a post
// (a marker on the line, a mono date on the rail, the organiser + content in the
// body), but *ahead* of now: it hangs off the line above the composer, with an
// accent node ring marking it as planned rather than past. Rendered by Timeline
// above the now-node; the parent orders them furthest-first so the nearest event
// sits just above "now".
export default function EventTimelineEntry({ event }) {
  const d = parseEventDate(event.event_date);
  const dayNum = d ? d.getDate() : "";
  const month = d ? d.toLocaleDateString(undefined, { month: "short" }) : "";
  const cancelled = event.status === "cancelled";
  const going = event.rsvp?.counts?.going || 0;
  const maybe = event.rsvp?.counts?.maybe || 0;

  return (
    <article className={`tl-entry tl-entry--future ${cancelled ? "tl-entry--off" : ""}`}>
      <div className="tl-rail">
        <span className="tl-avatar-node">
          <Avatar user={event.organiser} size="xs" />
        </span>
        <time
          className="font-mono text-xs tabular-nums text-accent-deep"
          dateTime={event.event_date}
        >
          {dayNum}
          <br />
          {month}
        </time>
      </div>

      <div className="tl-body">
        <div className="flex flex-wrap items-baseline gap-x-1.5">
          <Link
            to={`/g/${event.group.id}/events/${event.id}`}
            className="font-semibold text-ink transition hover:text-accent-deep"
          >
            {event.title}
          </Link>
          {cancelled && <span className="ev-tag ev-tag--off">Cancelled</span>}
        </div>
        <p className="text-sm text-ink-faint">
          {event.organiser.display_name}
          {" · "}
          <span className="font-mono">{formatEventWhen(event)}</span>
        </p>
        {event.description && (
          <p className="mt-1 line-clamp-2 text-sm text-ink-soft">
            {event.description}
          </p>
        )}
        <div className="mt-2">
          <DimensionChips event={event} />
        </div>
        {(going > 0 || maybe > 0) && (
          <p className="mt-2 text-xs text-ink-faint">
            {going} going{maybe > 0 ? ` · ${maybe} maybe` : ""}
          </p>
        )}
      </div>
    </article>
  );
}
