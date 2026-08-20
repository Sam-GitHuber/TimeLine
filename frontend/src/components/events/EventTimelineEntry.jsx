import { useState } from "react";
import { Link } from "react-router-dom";
import Avatar from "../Avatar.jsx";
import DimensionChips from "./DimensionChips.jsx";
import Lightbox from "../Lightbox.jsx";
import PhotoGrid from "../PhotoGrid.jsx";
import ReactionBar from "../ReactionBar.jsx";
import {
  parseEventDate,
  formatEventWhen,
  formatEventTimeParts,
} from "../../utils.js";

// An event as an entry on the timeline spine — the same shape as a post (a marker
// on the line, mono type on the rail, the organiser + content in the body), so an
// event reads as part of the one continuous line whether it's ahead of now or
// behind it. `variant` decides which:
//
// - "future" (above the now-node): the date sits on the rail in accent, and the
//   body carries the live details — description, the dimension chips, RSVP counts.
//   (There are no day dividers above the now-node, so the rail is the only place
//   outside the chips that dates it.)
// - "past"   (below the now-node, among the posts): a quiet **recap**. The rail
//   shows the clock time like a post (the day divider already gives the date), the
//   body drops the description and the live RSVP for the turnout alone — the
//   event has become a memory, not a thing to act on.
//
// Neither variant writes the when in its body: the rail and the chips say it, and
// the Date · Time · Where chips stay on a recap too because they're the record of
// what the event settled on, and the one thing a recap is most defined by is its
// date.
//
// A cancelled event is dimmed and tagged in either direction. A past one carries
// **no tag** — its position below the now-node, under a dated day divider, among
// posts equally in the past that wear no label, already says it happened.
export default function EventTimelineEntry({ event, variant = "future" }) {
  const past = variant === "past";
  const cancelled = event.status === "cancelled";
  const going = event.rsvp?.counts?.going || 0;
  const maybe = event.rsvp?.counts?.maybe || 0;
  const [lightboxIndex, setLightboxIndex] = useState(null);
  const eventPath = `/g/${event.group.id}/events/${event.id}`;

  // **The tiles here are a preview, and the viewer they open holds exactly
  // them.** The first few photos ride the event payload (already pruned to the
  // uploaders this viewer may see); the album itself is paginated, lives on the
  // event page, and can be two hundred photos long.
  //
  // This card used to fetch it on open, which couldn't work twice over: a plain
  // `useQuery` gets DRF's *first page* and never any of the rest, so a "+7" tile
  // labelled "view all 11 photos" opened a viewer that said "1 / 20" on an album
  // of fifty, with the last thirty unreachable and the arrows wrapping round —
  // and it cached that page-shaped answer under `['eventPhotos', id]`, the key
  // the event page reads with `useInfiniteQuery`. Two shapes, one cache entry:
  // opening a card and then walking to the event page inside the 5-minute
  // `gcTime` handed the infinite observer a `{results, next, count}` with no
  // `pages`, and the whole app went blank.
  //
  // So the card fetches nothing at all. Tapping a preview opens those previews;
  // the "+N" is a link to the event page, where the real, paged album is (see
  // `PhotoGrid`). Nothing but `EventPhotos` reads `['eventPhotos', id]` now, and
  // it is the only shape stored there.
  const previews = event.photos ?? [];

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
          <Link
            to={eventPath}
            className={`font-semibold transition hover:text-accent-deep ${
              past ? "text-ink-soft" : "text-ink"
            }`}
          >
            {event.title}
          </Link>
          {cancelled && <span className="ev-tag ev-tag--off">Cancelled</span>}
        </div>

        {/* Organiser and venue — **not the when** (#293; see the header above
            and events.md, "A timeline entry says its when nowhere in its body"). */}
        <p className="text-sm text-ink-faint">
          {event.organiser.display_name}
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

        {/* The album's first few, in the two-column grid a post's photos use —
            an event entry reads as part of the one line, so its photos look
            like the line's photos. Drawn on a past recap as much as on a future
            entry: "before, during and after" is the whole point, and the recap
            is where the after lands. */}
        <PhotoGrid
          images={previews}
          total={event.photo_count}
          max={4}
          label="event photo"
          overflowTo={eventPath}
          overflowLabel={`See all ${event.photo_count} photos on the event`}
          onOpen={setLightboxIndex}
        />

        {past
          ? going > 0 && (
              <p className="mt-1 text-xs text-ink-faint">{going} went</p>
            )
          : (going > 0 || maybe > 0) && (
              <p className="mt-2 text-xs text-ink-faint">
                {going} going{maybe > 0 ? ` · ${maybe} maybe` : ""}
              </p>
            )}

        {/* The same reaction row a post on this spine carries. An event entry
            reads as part of the one line, so it gets the one line's affordances
            — react here, and follow the count through to the thread.

            **The thread itself stays on the event page**, unlike a post's,
            which expands inline. A post is the whole content; an event's
            conversation sits beside its polls, its RSVP and its chips, and
            unfolding all of that into a timeline row would bury the posts
            below it. The count is the link. */}
        <ReactionBar
          eventId={event.id}
          reactions={event.reactions}
          trailing={
            <Link
              to={eventPath}
              className="rounded-lg text-sm text-ink-faint transition hover:text-accent-deep"
            >
              {event.comment_count > 0
                ? `${event.comment_count} ${
                    event.comment_count === 1 ? "comment" : "comments"
                  }`
                : "Comment"}
              {event.new_comment_count > 0 && (
                <span className="ml-1.5 font-semibold tabular-nums text-accent-deep">
                  · {event.new_comment_count} new
                </span>
              )}
            </Link>
          }
        />
      </div>

      {lightboxIndex !== null && previews[lightboxIndex] && (
        <Lightbox
          images={previews}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onIndexChange={setLightboxIndex}
          caption={previews[lightboxIndex].uploader?.display_name}
        />
      )}
    </article>
  );
}

// The rail voice-of-time: a past event shows its clock time like a post (the day
// divider carries the date); a future event shows its date (there are no day
// dividers above now) in accent.
//
// Every branch is a `<time>` carrying the **whole** when in `title` +
// `aria-label`, exactly as `PostCard` does and for the same two reasons, both of
// which bind harder here since #293 made the rail the entry's only statement of
// time in the body: the visible text splits over two lines ("1:00" / "pm", "20"
// / "Aug"), which assistive tech reads as two fragments, and the visible form
// is lossy — an accent rail shows day and month with no year, so two upcoming
// events twelve months apart draw the same two lines. `formatEventWhen` adds the
// year whenever the event isn't in the current one, and the `Date` chip below
// the title carries it in full either way. The all-day branch is a `<time>` too
// so it picks up `.tl-rail > time` in `index.css` (display/leading/padding) —
// as a `<span>` it sat a couple of pixels off the clock times above and below it
// in the same column.
function Rail({ event, past }) {
  const when = formatEventWhen(event);
  const label = when && (event.start_time ? when : `${when} · all day`);

  if (past) {
    const parts = formatEventTimeParts(event.start_time);
    return (
      <time
        className="font-mono text-xs tabular-nums text-ink-faint"
        dateTime={event.starts_at}
        title={label || undefined}
        aria-label={label || undefined}
      >
        {parts ? parts.time : "all"}
        <br />
        {parts ? parts.meridiem : "day"}
      </time>
    );
  }

  const d = parseEventDate(event.event_date);
  return (
    <time
      className="font-mono text-xs tabular-nums text-accent-deep"
      dateTime={event.event_date}
      title={label || undefined}
      aria-label={label || undefined}
    >
      {d ? d.getDate() : ""}
      <br />
      {d ? d.toLocaleDateString(undefined, { month: "short" }) : ""}
    </time>
  );
}
