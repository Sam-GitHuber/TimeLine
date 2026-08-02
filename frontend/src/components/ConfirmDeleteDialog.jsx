import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { serverMessage } from "../errors.js";

// A confirm step before a destructive action. Deleting something that carries
// other people's replies, reactions or photos isn't a one-click action, so both
// callers stop here first: `PostMenu` (issue #62) and the owner controls on a
// comment (issue #128).
//
// Same modal shape as `ReportModal` — body portal, Escape to close (blocked
// while the request is in flight, so you can't dismiss a half-done delete),
// backdrop click to cancel, and the error surfaced with `role="alert"`.
//
// The wording is the caller's: what a delete takes with it differs (a post's
// photos, a comment's replies), and a vague "this can't be undone" would be the
// one thing the dialog exists to make specific.
export default function ConfirmDeleteDialog({
  title,
  description,
  label,
  errorFallback = "Couldn’t delete that.",
  onConfirm,
  onCancel,
  pending,
  error,
}) {
  const dialogRef = useRef(null);

  useEffect(() => {
    function onKey(event) {
      if (event.key === "Escape" && !pending) onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, pending]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  const stop = (event) => event.stopPropagation();

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4 backdrop-blur-sm"
      onClick={pending ? undefined : onCancel}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onClick={stop}
        className="w-full max-w-sm rounded-2xl border border-line bg-raised p-5 shadow-xl outline-none"
      >
        <h2 className="font-display text-lg font-semibold text-ink">{title}</h2>
        <p className="mt-2 text-sm text-ink-soft">{description}</p>
        {error && (
          <p role="alert" className="mt-2 text-sm text-red-600">
            {serverMessage(error, errorFallback)}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="btn btn-ghost btn-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="btn btn-sm bg-red-600 text-white hover:bg-red-700"
          >
            {pending ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
