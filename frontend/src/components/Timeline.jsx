import PostCard from "./PostCard.jsx";
import EventTimelineEntry from "./events/EventTimelineEntry.jsx";
import { dayKey, dayHeading, eventLocalStart } from "../utils.js";

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
  // `at` is the local Date each row is both sorted and day-grouped by. A post
  // uses its `created_at` instant, read in the viewer's zone. An event uses its
  // own wall-clock start (`eventLocalStart`), *not* the `starts_at` instant —
  // an event's day belongs to the event's timezone, and its card says so. See
  // the note on `eventLocalStart`.
  const items = [
    ...posts.map((p) => ({ kind: "post", at: new Date(p.created_at), data: p })),
    ...pastEvents.map((e) => ({
      kind: "event",
      at: eventLocalStart(e) ?? new Date(e.created_at),
      data: e,
    })),
  ]
    // Newest-first. Posts already arrive sorted; merging events needs the sort.
    .sort((a, b) => b.at - a.at);

  const rows = [];
  let lastDay = null;

  for (const item of items) {
    const key = dayKey(item.at);
    if (key !== lastDay) {
      rows.push(<DayDivider key={`day-${key}`} at={item.at} />);
      lastDay = key;
    }
    if (item.kind === "event") {
      // A past event is a spine entry too — the same shape as its future self and
      // the posts around it — in a quiet "recap" variant, so a memory reads as
      // part of the one line, not a boxed card wedged into it.
      rows.push(
        <EventTimelineEntry
          key={`ev-${item.data.id}`}
          event={item.data}
          variant="past"
        />
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

function DayDivider({ at }) {
  const { label, sub } = dayHeading(at);
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
