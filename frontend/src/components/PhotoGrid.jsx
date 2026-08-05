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
// the first few and the last tile carries a "+N" that opens the viewer at that
// point. They're two numbers because the album can be bigger than the payload:
// see `photo_count` vs `photos` in the event serializer. A post passes neither
// (it's capped at ten and always sends them all), so it gets the old behaviour
// with no branch at the call site.
export default function PhotoGrid({
  images,
  onOpen,
  max = null,
  total = null,
  label = "photo",
}) {
  if (!images?.length) return null;

  const shown = max ? images.slice(0, max) : images;
  const count = total ?? images.length;
  // How many the grid isn't drawing. Counted against the whole album, not just
  // the slice, so it stays right when the payload carries fewer than `max`.
  const extra = count - shown.length;
  const single = shown.length === 1 && extra === 0;

  return (
    <div
      className={`mt-2.5 grid gap-1.5 ${single ? "grid-cols-1" : "grid-cols-2"}`}
    >
      {shown.map((image, i) => {
        const last = i === shown.length - 1;
        const showOverlay = extra > 0 && last;
        return (
          <button
            key={image.id}
            type="button"
            onClick={() => onOpen(i)}
            aria-label={
              showOverlay
                ? `View all ${count} photos`
                : `View ${label} ${i + 1} of ${count}`
            }
            className="relative block cursor-pointer overflow-hidden rounded-xl border border-line"
          >
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
              // Decorative: the button's aria-label above already says "view all
              // N photos", so announcing the number twice would just be noise.
              <span
                aria-hidden="true"
                className="absolute inset-0 flex items-center justify-center bg-black/45 font-mono text-lg font-semibold text-white"
              >
                +{extra}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
