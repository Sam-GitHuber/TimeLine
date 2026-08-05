import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useEscapeLayer, useScrollLock } from "./modalLayer.js";

// A full-screen photo viewer for a post's images or an event's album. Opens at
// a given index and lets you flip through with the on-screen arrows or the
// ← / → keys; Esc, the close button, or a click on the dark backdrop dismiss
// it. Rendered in a portal on <body> so it sits above the app chrome regardless
// of where the clicked thumbnail lives in the layout.
//
// `caption` and `onDelete` exist for the album, where a photo has an author of
// its own (a post's images inherit the post's) and can be taken back down by
// the person who added it, the organiser or a group admin. A post passes
// neither, so its viewer is unchanged.
export default function Lightbox({
  images,
  index,
  onClose,
  onIndexChange,
  caption = null,
  onDelete = null,
}) {
  const count = images.length;
  const current = images[index];
  const dialogRef = useRef(null);

  const goPrev = useCallback(
    () => onIndexChange((index - 1 + count) % count),
    [index, count, onIndexChange]
  );
  const goNext = useCallback(
    () => onIndexChange((index + 1) % count),
    [index, count, onIndexChange]
  );

  // Escape closes — through the shared layer stack (`modalLayer.js`), which
  // keeps the capture-phase swallow this viewer has always needed (it opens from
  // inside the messages drawer, and the drawer closes on Escape too, so one
  // press used to shut the photo *and* the panel behind it) while also making a
  // dialog opened *on top of* the viewer win the press instead of losing it.
  useEscapeLayer(onClose);

  // The arrows stay this component's own, in the capture phase for the same
  // reason and with no `stopPropagation`: nothing else in the app claims them.
  useEffect(() => {
    function onKey(event) {
      if (event.key === "ArrowLeft" && count > 1) goPrev();
      else if (event.key === "ArrowRight" && count > 1) goNext();
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [goPrev, goNext, count]);

  // While the viewer is open: lock background scroll (counted, so a confirm
  // dialog stacked over this one can't leave the page unscrollable — see
  // `modalLayer.js`), move focus into the dialog (so keys work + screen readers
  // land here), and restore focus on close.
  useScrollLock();
  useEffect(() => {
    const previouslyFocused = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, []);

  if (!current) return null;

  // Stop clicks on the controls/image from bubbling to the backdrop (which closes).
  const stop = (event) => event.stopPropagation();

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Photo viewer"
      tabIndex={-1}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm outline-none"
    >
      <div className="absolute right-3 top-3 flex items-center gap-2">
        {onDelete && (
          <button
            type="button"
            onClick={(e) => {
              stop(e);
              onDelete();
            }}
            aria-label="Remove this photo"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-red-600/80"
          >
            <Icon path="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20"
        >
          <Icon path="M6 6l12 12M18 6L6 18" />
        </button>
      </div>

      {count > 1 && (
        <button
          type="button"
          onClick={(e) => {
            stop(e);
            goPrev();
          }}
          aria-label="Previous photo"
          className="absolute left-2 flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20 sm:left-4"
        >
          <Icon path="M15 5l-7 7 7 7" />
        </button>
      )}

      <img
        src={current.image}
        alt={`Photo ${index + 1} of ${count}`}
        onClick={stop}
        className="max-h-[90vh] max-w-[92vw] rounded-lg object-contain shadow-2xl"
      />

      {count > 1 && (
        <button
          type="button"
          onClick={(e) => {
            stop(e);
            goNext();
          }}
          aria-label="Next photo"
          className="absolute right-2 flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20 sm:right-4"
        >
          <Icon path="M9 5l7 7-7 7" />
        </button>
      )}

      {/* Who took it, and where you are in the set. One row so a single photo
          with a caption still gets a place to put it, and an album gets both
          without stacking two floating pills on top of each other. */}
      {(caption || count > 1) && (
        <div className="absolute bottom-4 flex max-w-[92vw] items-center gap-2 rounded-full bg-black/50 px-3 py-1 text-xs text-white">
          {caption && <span className="truncate">{caption}</span>}
          {caption && count > 1 && (
            <span aria-hidden="true" className="text-white/40">
              ·
            </span>
          )}
          {count > 1 && (
            <span className="font-mono tabular-nums">
              {index + 1} / {count}
            </span>
          )}
        </div>
      )}
    </div>,
    document.body
  );
}

// A small stroked icon (chevrons / close) sharing one consistent look.
function Icon({ path }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}
