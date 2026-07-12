import { useEffect, useRef } from "react";

// The four one-tap reactions — a low-friction default that covers most of what
// people actually want to say, without opening the full picker. Kept positive on
// purpose (product philosophy: sustain warm real-life connections, not the
// full spectrum of internet reactions).
const QUICK_EMOJI = ["👍", "❤️", "😂", "🎉"];

// A compact reaction bar: the four quick emoji plus a "more" button that expands
// to the full picker. Positioned by its parent portal (fixed/absolute on
// <body>); it does no positioning itself. `reactedEmojis` is the set the viewer
// has already used, so a quick button shows as active and re-tapping it removes
// the reaction (same toggle as the chips). `ignoreRef` is the trigger button, so
// re-clicking it to close doesn't immediately reopen.
export default function QuickReactionPopover({
  onPick,
  onMore,
  onClose,
  ignoreRef,
  reactedEmojis,
}) {
  const wrapRef = useRef(null);

  useEffect(() => {
    function onPointerDown(e) {
      if (ignoreRef?.current && ignoreRef.current.contains(e.target)) return;
      if (wrapRef.current && !wrapRef.current.contains(e.target)) onClose();
    }
    function onKeyDown(e) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, ignoreRef]);

  return (
    <div
      ref={wrapRef}
      role="dialog"
      aria-label="Quick reactions"
      className="flex items-center gap-0.5 rounded-full border border-line bg-raised p-1 shadow-lg"
    >
      {QUICK_EMOJI.map((emoji) => {
        const active = reactedEmojis?.has(emoji);
        return (
          <button
            key={emoji}
            type="button"
            onClick={() => onPick(emoji)}
            aria-pressed={!!active}
            aria-label={`React ${emoji}${active ? " (tap to remove)" : ""}`}
            className={`flex h-9 w-9 items-center justify-center rounded-full text-xl leading-none transition hover:scale-110 ${
              active ? "bg-accent-tint" : "hover:bg-accent-tint"
            }`}
          >
            <span aria-hidden="true">{emoji}</span>
          </button>
        );
      })}

      <span className="mx-0.5 h-6 w-px bg-line" aria-hidden="true" />

      <button
        type="button"
        onClick={onMore}
        aria-label="More emoji"
        className="flex h-9 w-9 items-center justify-center rounded-full text-ink-faint transition hover:bg-accent-tint hover:text-accent-deep"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="h-5 w-5"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </div>
  );
}
