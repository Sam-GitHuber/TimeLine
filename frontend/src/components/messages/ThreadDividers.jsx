// The two things that break a transcript into readable stretches (Phase 9b M9b).
//
// A day separator answers *which day*, which is what frees every bubble below it
// to show only a clock time. The unread divider answers *where you stopped*, and
// it's accented while the separators aren't — because the thread opens at it,
// and it's the one line on screen you're being asked to look for.

export function DaySeparator({ label }) {
  return (
    <li className="flex items-center gap-3 py-3" aria-hidden="false">
      <span className="h-px flex-1 bg-line" />
      <span className="font-mono text-[0.65rem] uppercase tracking-wide text-ink-faint">
        {label}
      </span>
      <span className="h-px flex-1 bg-line" />
    </li>
  );
}

// `elementRef` is how the thread scrolls itself here on open — a callback ref
// passed down rather than a wrapper element, because the transcript is a `<ul>`
// and an `<li>` wrapped around an `<li>` is invalid HTML.
export function UnreadDivider({ count, elementRef }) {
  return (
    <li ref={elementRef} className="flex items-center gap-3 py-3">
      <span className="h-px flex-1 bg-accent/40" />
      <span className="text-[0.7rem] font-semibold text-accent-deep">
        {count === 1 ? "1 unread message" : `${count} unread messages`}
      </span>
      <span className="h-px flex-1 bg-accent/40" />
    </li>
  );
}
