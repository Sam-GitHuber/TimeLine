import { useMessaging } from "../messaging.jsx";

// Shared chrome for the two companion drawers (Messages on the right, Groups on
// the left). Keeping these in one place is what lets both panels read as one
// system — the same brand glyph, icon stroke, and icon-button treatment — so a
// tweak to one can't leave the other behind.

// The little brand glyph (a node on the spine) — ties a private/companion panel
// back to the public timeline's living line.
export function SpineMark() {
  return (
    <svg
      width="12"
      height="16"
      viewBox="0 0 16 20"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
    >
      <line
        x1="8"
        y1="2"
        x2="8"
        y2="18"
        stroke="var(--color-spine)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="8" cy="6" r="4" fill="var(--color-accent)" />
    </svg>
  );
}

export function StrokeIcon({ path, size = 20 }) {
  return (
    <svg
      width={size}
      height={size}
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

// `pressed` makes this a *toggle* rather than a plain action: it sets
// `aria-pressed`, which is what tells a screen reader the control has an on/off
// state at all, and dims the icon so the on state is visible without colour
// alone. Left undefined (the default) the button stays a plain button — an
// `aria-pressed="false"` on a one-shot action would announce a state it doesn't
// have.
export function IconButton({ onClick, label, children, pressed, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition hover:bg-accent-tint hover:text-accent-deep disabled:opacity-45 ${
        pressed ? "text-ink-faint" : "text-ink-soft"
      }`}
    >
      {children}
    </button>
  );
}

// One header shape for every companion-drawer view: optional back, a title
// area, optional actions, and always a close button — so the panel feels like
// one place no matter which view is showing. Shared here (not owned by
// MessagesDrawer) so a picker component like NewChatPicker can use the same
// header without an import cycle.
export function PanelHeader({ onBack, actions, children }) {
  const { close, isWriting } = useMessaging();
  // Both of these unmount the panel below — Back switches `view`, ✕ closes the
  // drawer outright — and two of the panels are the only renderer of their own
  // rejection (#258). So while one has a write out, both **hold**: visibly
  // unavailable, the way `ConfirmDeleteDialog` holds its Cancel, rather than
  // silently swallowing the press. ✕ especially: "I'm finished with messages" is
  // a real intention, and a button that just does nothing reads as broken.
  // `close()` declines on its own too, for the Escape key that has no button.
  return (
    <header className="flex items-center gap-1.5 border-b border-line px-3 py-2.5">
      {onBack && (
        <IconButton onClick={onBack} label="Back" disabled={isWriting}>
          <StrokeIcon path="M15 5l-7 7 7 7" />
        </IconButton>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-2 pl-1">
        {children}
      </div>
      {actions}
      <IconButton onClick={close} label="Close messages" disabled={isWriting}>
        <StrokeIcon path="M6 6l12 12M18 6L6 18" />
      </IconButton>
    </header>
  );
}
