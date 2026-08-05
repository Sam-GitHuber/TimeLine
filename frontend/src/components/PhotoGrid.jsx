import { Link } from "react-router-dom";

// The photo grid a post and an event album both render, lifted out of PostCard
// so the two can't drift. It is *navigation* — a compact index of what's there —
// and deliberately not where a photo gets looked at; that's the Lightbox's job.
//
// Two rules, both there because a card carrying its photos full-width turns one
// entry into screens of scrolling and buries the rest of the timeline:
//
// - **One photo keeps its natural shape** (height-capped). A single picture is
//   the entry's content, so squaring it off would crop it for nothing.
// - **Several go into a two-column square grid.** Cost per entry is then bounded
//   however many photos there are.
//
// `max` caps how many tiles are drawn and `total` is how many photos actually
// exist — an event album is added to over the life of an event, so a card shows
// the first few and the last tile carries a "+N". They're two numbers because
// the album can be bigger than the payload: see `photo_count` vs `photos` in the
// event serializer. A post passes neither (it's capped at ten and always sends
// them all), so it gets the old behaviour with no branch at the call site.
//
// **Where the "+N" goes is the caller's** (`overflowTo` + `overflowLabel`).
// A post's images are one bounded set with nowhere else to go, so its "+N" — if
// it ever had one — opens the viewer at that tile, and that's the default. An
// event's album is paginated and lives on the event page, so a viewer opened
// from a card structurally *cannot* hold it: the tiles here are a preview, and
// its "+N" is a link to the page where the whole album is. That's why the
// per-tile labels count against `shown`, not `count` — the viewer a tile opens
// holds exactly the tiles you can see, and "photo 1 of 20" opening a viewer that
// reads "1 / 4" is the card lying about what it has.
export default function PhotoGrid({
  images,
  onOpen,
  max = null,
  total = null,
  label = "photo",
  overflowTo = null,
  overflowLabel = null,
}) {
  if (!images?.length) return null;

  const shown = max ? images.slice(0, max) : images;
  const count = total ?? images.length;
  // How many the grid isn't drawing. Counted against the whole album, not just
  // the slice, so it stays right when the payload carries fewer than `max`.
  const extra = count - shown.length;
  const single = shown.length === 1 && extra === 0;
  const tileClass =
    "relative block cursor-pointer overflow-hidden rounded-xl border border-line";

  return (
    <div
      className={`mt-2.5 grid gap-1.5 ${single ? "grid-cols-1" : "grid-cols-2"}`}
    >
      {shown.map((image, i) => {
        const last = i === shown.length - 1;
        const showOverlay = extra > 0 && last;
        const tile = (
          <>
            <img
              src={image.thumbnail}
              width={image.width}
              height={image.height}
              loading="lazy"
              alt=""
              className={
                single
                  ? "max-h-[28rem] w-full object-cover transition hover:opacity-95"
                  : "aspect-square w-full object-cover transition hover:opacity-95"
              }
            />
            {showOverlay && (
              // Decorative: the control's aria-label already says how many
              // there are, so announcing the number twice would just be noise.
              <span
                aria-hidden="true"
                className="absolute inset-0 flex items-center justify-center bg-black/45 font-mono text-lg font-semibold text-white"
              >
                +{extra}
              </span>
            )}
          </>
        );

        // ⚠️ When the "+N" is a link, the photo *under* it isn't openable from
        // the grid — that's deliberate, not an oversight. It's one tap from
        // here either way (it's still in the preview viewer, an arrow away), and
        // a tile that opens a four-photo viewer when it's labelled with the
        // twenty photos it's standing in for is the thing being fixed.
        if (showOverlay && overflowTo) {
          return (
            <Link
              key={image.id}
              to={overflowTo}
              aria-label={overflowLabel ?? `See all ${count} photos`}
              className={tileClass}
            >
              {tile}
            </Link>
          );
        }

        return (
          <button
            key={image.id}
            type="button"
            onClick={() => onOpen(i)}
            aria-label={
              showOverlay
                ? `View all ${count} photos`
                : `View ${label} ${i + 1} of ${shown.length}`
            }
            className={tileClass}
          >
            {tile}
          </button>
        );
      })}
    </div>
  );
}
