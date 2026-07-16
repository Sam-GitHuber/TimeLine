import PostCard from "./PostCard.jsx";
import EventCard from "./events/EventCard.jsx";
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
// On a group timeline, `pastEvents` (Phase 8b) are merged in: an event whose
// time has passed leaves the "upcoming" region and **falls into the timeline
// among the posts** as a quiet recap card, in the same strict reverse-
// chronological order — so scrolling back one day you see everything that
// happened, posts and events interwoven. It's the same living line paying off:
// your past is a single readable record, not two parallel lists.
export default function Timeline({ posts = [], pastEvents = [], header = null }) {
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
