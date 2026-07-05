import PostCard from "./PostCard.jsx";
import { dayKey, dayHeading } from "../utils.js";

// The feed as a literal timeline: posts hang off one continuous vertical line
// (the spine, drawn by `.tl-feed`), grouped under day dividers. `header` is an
// optional live element for the top of the line — on the home feed that's the
// compose box (the "now" node); on a profile it's omitted.
//
// Posts arrive already newest-first from the API (TimeLine's whole point), so
// walking them in order and starting a new divider whenever the calendar day
// changes yields correctly-ordered day groups with no client-side sorting.
export default function Timeline({ posts = [], header = null }) {
  const rows = [];
  let lastDay = null;

  for (const post of posts) {
    const key = dayKey(post.created_at);
    if (key !== lastDay) {
      rows.push(<DayDivider key={`day-${key}`} isoString={post.created_at} />);
      lastDay = key;
    }
    rows.push(<PostCard key={post.id} post={post} />);
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
