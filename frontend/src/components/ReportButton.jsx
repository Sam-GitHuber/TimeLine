import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";

// A quiet "Report" control for a post or comment (Phase 7 content-takedown
// path). Pass exactly one of `postId` / `commentId`, plus the content author's
// id so we can hide the control on your own content (reporting yourself is
// pointless). Opens a small modal for an optional reason and POSTs a report the
// maintainer reviews in the Django admin.
export default function ReportButton({ postId = null, commentId = null, authorId }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);

  // Don't offer "report" on your own post/comment.
  if (user && authorId != null && user.pk === authorId) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="transition hover:text-accent-deep"
      >
        Report
      </button>
      {open && (
        <ReportModal
          postId={postId}
          commentId={commentId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

// The report dialog itself, exported so the post ⋯ overflow menu (issue #62)
// can open it as its "Report" item without re-rendering the inline trigger.
// `ReportButton` (the inline trigger) is still used for comments.
export function ReportModal({ postId, commentId, onClose }) {
  const dialogRef = useRef(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    function onKey(event) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await api.reportContent({ postId, commentId, reason: reason.trim() });
      setDone(true);
    } catch (err) {
      setError(err.message || "Couldn’t send the report.");
      setSubmitting(false);
    }
  }

  const target = postId ? "post" : "comment";
  const stop = (event) => event.stopPropagation();

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Report ${target}`}
        tabIndex={-1}
        onClick={stop}
        className="w-full max-w-sm rounded-2xl border border-line bg-raised p-5 shadow-xl outline-none"
      >
        {done ? (
          <>
            <h2 className="font-display text-lg font-semibold text-ink">
              Thanks for letting us know
            </h2>
            <p className="mt-2 text-sm text-ink-soft">
              We’ll review this {target} and take it down if it breaks the rules.
            </p>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="btn btn-primary btn-sm"
              >
                Done
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <h2 className="font-display text-lg font-semibold text-ink">
              Report this {target}
            </h2>
            <p className="mt-2 text-sm text-ink-soft">
              Tell us what’s wrong (optional) — for example it infringes your
              copyright, or shouldn’t be here. It goes to the site owner to
              review.
            </p>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={1000}
              autoFocus
              placeholder="What’s the problem?"
              className="mt-3 w-full resize-none rounded-xl border border-line-strong bg-surface px-3 py-2 text-sm text-ink transition placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-tint"
            />
            {error && (
              <p role="alert" className="mt-2 text-sm text-red-600">
                {error}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="btn btn-ghost btn-sm"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="btn btn-primary btn-sm"
              >
                {submitting ? "Sending…" : "Send report"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body
  );
}
