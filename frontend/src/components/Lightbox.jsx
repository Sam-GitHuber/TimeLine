import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

// A full-screen photo viewer for a post's images. Opens at a given index and
// lets you flip through with the on-screen arrows or the ← / → keys; Esc, the
// close button, or a click on the dark backdrop dismiss it. Rendered in a
// portal on <body> so it sits above the app chrome regardless of where the
// clicked thumbnail lives in the layout.
export default function Lightbox({ images, index, onClose, onIndexChange }) {
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

  // Keyboard: arrows navigate, Escape closes.
  useEffect(() => {
    function onKey(event) {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowLeft" && count > 1) goPrev();
      else if (event.key === "ArrowRight" && count > 1) goNext();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, goPrev, goNext, count]);

  // While the viewer is open: lock background scroll, move focus into the
  // dialog (so keys work + screen readers land here), and restore focus on close.
  useEffect(() => {
    const previouslyFocused = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
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
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-3 top-3 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20"
      >
        <Icon path="M6 6l12 12M18 6L6 18" />
      </button>

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

      {count > 1 && (
        <div className="absolute bottom-4 rounded-full bg-black/50 px-3 py-1 font-mono text-xs tabular-nums text-white">
          {index + 1} / {count}
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
