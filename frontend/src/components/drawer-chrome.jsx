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

export function IconButton({ onClick, label, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-soft transition hover:bg-accent-tint hover:text-accent-deep"
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
  const { close } = useMessaging();
  return (
    <header className="flex items-center gap-1.5 border-b border-line px-3 py-2.5">
      {onBack && (
        <IconButton onClick={onBack} label="Back">
          <StrokeIcon path="M15 5l-7 7 7 7" />
        </IconButton>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-2 pl-1">
        {children}
      </div>
      {actions}
      <IconButton onClick={close} label="Close messages">
        <StrokeIcon path="M6 6l12 12M18 6L6 18" />
      </IconButton>
    </header>
  );
}
