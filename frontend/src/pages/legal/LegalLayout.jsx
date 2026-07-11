import { Link } from "react-router-dom";

// Shared chrome + typography for the two legal pages (Terms, Privacy). They live
// at top-level routes (reachable logged-out from sign-up, and logged-in from the
// footer), so this provides their own minimal header + a readable prose column
// rather than relying on the app Layout. Styling is all design-system tokens.
//
// The document text is the single source of truth — it lives in the page
// components (TermsPage / PrivacyPage) as structured content using the small
// primitives exported here, so there's no separate copy to drift out of sync.

export function LegalPage({ title, updated, children }) {
  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line bg-raised">
        <div className="mx-auto flex max-w-2xl items-center gap-2 px-4 py-3">
          <Link
            to="/"
            className="flex items-center gap-2 font-display text-lg font-bold -tracking-[0.02em] text-ink hover:opacity-80"
          >
            <svg width="14" height="18" viewBox="0 0 16 20" fill="none" aria-hidden="true">
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
            TimeLine
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="font-display text-3xl font-bold -tracking-[0.02em] text-ink">
          {title}
        </h1>
        {updated && (
          <p className="mt-2 text-sm text-ink-faint">Last updated {updated}</p>
        )}
        <div className="mt-8 space-y-8">{children}</div>

        <p className="mt-12 border-t border-line pt-6 text-sm text-ink-faint">
          <Link to="/terms" className="font-medium text-accent-deep hover:underline">
            Terms of Service
          </Link>{" "}
          ·{" "}
          <Link to="/privacy" className="font-medium text-accent-deep hover:underline">
            Privacy Policy
          </Link>{" "}
          ·{" "}
          <Link to="/" className="font-medium text-accent-deep hover:underline">
            Back to TimeLine
          </Link>
        </p>
      </main>
    </div>
  );
}

// A titled section of a legal document.
export function Section({ heading, children }) {
  return (
    <section className="space-y-3">
      <h2 className="font-display text-xl font-semibold -tracking-[0.01em] text-ink">
        {heading}
      </h2>
      {children}
    </section>
  );
}

// A paragraph of body copy, sized for comfortable reading.
export function P({ children }) {
  return <p className="text-[0.95rem] leading-relaxed text-ink-soft">{children}</p>;
}

// A bulleted list of points.
export function UL({ children }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5 text-[0.95rem] leading-relaxed text-ink-soft">
      {children}
    </ul>
  );
}
