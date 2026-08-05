import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api.js";
import { serverMessage } from "../errors.js";
import { useScrollLock } from "./modalLayer.js";

// The report dialog, opened from a ⋯ overflow menu's "Report" item — a post's
// (issue #62), a comment's (#128) or a message bubble's.
//
// There was once an inline `ReportButton` trigger here too, kept for comments
// while posts moved into a menu. Comments joined them in #128, at which point
// nothing rendered it, so it went and this file took the name of what's left.
//
// Pass exactly one of `postId` / `commentId` / `messageId`. Messages were added
// in Phase 9b M9b, alongside the ⋯ menu on a message bubble — before that this
// took two ids and derived its wording as "post or else comment", so wiring a
// message into it would have opened a dialog headed "Report this comment" and
// POSTed a report with no target at all.
export function ReportModal({ postId, commentId, messageId, onClose }) {
  const dialogRef = useRef(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  // Escape closes — but not while the report is in flight (issue #254). The
  // rejection is rendered *inside* this dialog, so dismissing it mid-request
  // unmounts the only thing that could have told you the report didn't send,
  // and the silence is indistinguishable from never having pressed the button.
  // Same gate `ConfirmDeleteDialog` puts on a half-done delete.
  useEffect(() => {
    function onKey(event) {
      if (event.key === "Escape" && !submitting) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, submitting]);

  // Counted + shared, like every other layer that covers the page — see
  // `modalLayer.js` for what a per-modal copy of this gets wrong.
  useScrollLock();
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await api.reportContent({
        postId,
        commentId,
        messageId,
        reason: reason.trim(),
      });
      // Clear `submitting` alongside `done`: the dismissal gates below read it,
      // and the success screen must stay dismissable by Escape and the backdrop.
      setSubmitting(false);
      setDone(true);
    } catch (err) {
      setError(serverMessage(err, "Couldn’t send the report."));
      setSubmitting(false);
    }
  }

  const target =
    postId != null ? "post" : commentId != null ? "comment" : "message";
  const stop = (event) => event.stopPropagation();

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4 backdrop-blur-sm"
      onClick={submitting ? undefined : onClose}
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
              {target === "message"
                ? "We’ll review this message and act on it if it breaks the rules."
                : `We’ll review this ${target} and take it down if it breaks the rules.`}
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
            {/* 🔒 Say plainly what reporting a private message hands over. Since
                Phase 9b M0 the site owner can't read a conversation any other
                way, so this is the one moment message text leaves the chat —
                and the disclosure is what makes that moderation design honest
                rather than a quiet exception to it. Not decoration: a Report
                that omits it looks finished while regressing M0's intent. */}
            {target === "message" && (
              <p className="mt-2 text-sm text-ink-soft">
                A copy of this message is sent with your report. It’s the only
                way the site owner can see it — they can’t read your
                conversations otherwise.
              </p>
            )}
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
                disabled={submitting}
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
