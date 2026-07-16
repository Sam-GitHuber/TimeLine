import PostCard from "./PostCard.jsx";
import EventCard from "./events/EventCard.jsx";
import EventTimelineEntry from "./events/EventTimelineEntry.jsx";
import { dayKey, dayHeading } from "../utils.js";

// The feed as a literal timeline: posts hang off one continuous vertical line
// (the spine, drawn by `.tl-feed`), grouped under day dividers. `header` is an
// optional live element for the top of the line — on the home feed that's the
// compose box (the "now" node); on a profile it's omitted.
//
// Posts arrive already newest-first from the API (TimeLine's whole point), so
// walking them in order and starting a new divider whenever the calendar day
// changes yields correctly-ordered day groups with no client-side sorting.
//
// The line runs in both directions (Phase 8b):
//
// - `futureEvents` hang off the line **above** the now-node, as post-shaped
//   entries ahead of now. The parent passes them furthest-first, so the nearest
//   event sits just above the composer — scroll up to travel forward in time.
// - `pastEvents` are merged **below** among the posts: an event whose time has
//   passed leaves the upcoming region and falls into the timeline as a quiet
//   recap card, in the same reverse-chronological order — so your past is a
//   single readable record of posts and events interwoven, not two lists.
export default function Timeline({
  posts = [],
  pastEvents = [],
  futureEvents = [],
  header = null,
}) {
  const items = [
    ...posts.map((p) => ({ kind: "post", time: p.created_at, data: p })),
    ...pastEvents.map((e) => ({ kind: "event", time: e.starts_at, data: e })),
  ]
    // Newest-first. Posts already arrive sorted; merging events needs the sort.
    .sort((a, b) => new Date(b.time) - new Date(a.time));

  const rows = [];
  let lastDay = null;

  for (const item of items) {
    const key = dayKey(item.time);
    if (key !== lastDay) {
      rows.push(<DayDivider key={`day-${key}`} isoString={item.time} />);
      lastDay = key;
    }
    if (item.kind === "event") {
      rows.push(
        <div key={`ev-${item.data.id}`} className="px-5 py-2">
          <EventCard event={item.data} />
        </div>
      );
    } else {
      rows.push(<PostCard key={item.data.id} post={item.data} />);
    }
  }

  return (
    <div className="tl-feed">
      {futureEvents.map((e) => (
        <EventTimelineEntry key={`fut-${e.id}`} event={e} />
      ))}
      {header}
      {rows}
    </div>
  );
}

function DayDivider({ isoString }) {
  const { label, sub } = dayHeading(isoString);
  return (
    <div className="tl-day">
      <span className="tl-day-dot" aria-hidden="true" />
      <div className="tl-day-label">
        <b>{label}</b>
        {sub && <span>{sub}</span>}
      </div>
    </div>
  );
}
