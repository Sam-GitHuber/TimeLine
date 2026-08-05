import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";
import { useScrollLock } from "./modalLayer.js";

// Disconnecting/blocking someone severs any *group* chats you only share
// through that connection — you're dropped to pending in them until you
// reconnect with everyone else there. Before ConnectButton/BlockButton fire
// the actual mutation, this fetches that impact and, if it's non-empty, makes
// the caller read the list and explicitly confirm. Modelled on Lightbox.jsx's
// dialog pattern (portal, role="dialog", focus management, Esc-to-cancel).
//
// The dialog stays up until the write it confirmed has actually landed (`busy`
// while it's in flight, `error` if it was rejected), rather than closing the
// moment you press Confirm. Closing first is what made a failed block invisible
// — the caller was left with no surface to report on and a button that still
// read "Block" (issue #236). Staying open also makes Confirm the retry, with
// the failure in front of you.
export default function DisconnectWarningModal({
  userId,
  userName,
  action,
  busy = false,
  error = null,
  onConfirm,
  onCancel,
}) {
  const dialogRef = useRef(null);

  const impactQuery = useQuery({
    queryKey: ["disconnect-impact", userId],
    queryFn: () => api.getDisconnectImpact(userId),
  });

  // Esc cancels, like every other dialog in the app — but not out from under a
  // write that's already gone to the server, which would leave you unable to
  // see how it turned out.
  useEffect(() => {
    function onKey(event) {
      if (event.key === "Escape" && !busy) onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, busy]);

  // Lock background scroll, move focus into the dialog, restore it on close.
  // The lock is counted and shared (`modalLayer.js`) rather than saved and put
  // back here: a copy of it in every modal is only correct while exactly one is
  // open, and the two that restore in the wrong order leave the page stuck.
  useScrollLock();
  useEffect(() => {
    const previouslyFocused = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, []);

  const chats = impactQuery.data?.chats ?? [];
  const hasImpact = chats.length > 0;
  const verb = action === "block" ? "Blocking" : "Disconnecting from";
  const label = action === "block" ? "Block" : "Disconnect";

  // Stop clicks inside the card from bubbling to the backdrop (which cancels).
  const stop = (event) => event.stopPropagation();

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4 backdrop-blur-sm"
      onClick={busy ? undefined : onCancel}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${label} confirmation`}
        tabIndex={-1}
        onClick={stop}
        className="w-full max-w-sm rounded-2xl border border-line bg-raised p-5 shadow-xl outline-none"
      >
        {impactQuery.isLoading ? (
          <p className="text-sm text-ink-faint">Checking shared chats…</p>
        ) : impactQuery.isError ? (
          <p className="text-sm text-red-600">
            Couldn’t check for shared chats. You can still continue.
          </p>
        ) : hasImpact ? (
          <>
            <p className="text-sm text-ink">
              {verb} <strong>{userName}</strong> will remove you from these
              chats until you’re connected to everyone again:
            </p>
            <ul className="mt-3 max-h-40 space-y-1 overflow-y-auto rounded-xl border border-line bg-surface p-3 text-sm text-ink-soft">
              {chats.map((chat) => (
                <li key={chat.id}>{chat.title}</li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-sm text-ink">
            {label} <strong>{userName}</strong>?
          </p>
        )}

        {error && (
          <p role="alert" className="mt-3 text-sm text-red-600">
            {error}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="btn btn-ghost btn-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy || impactQuery.isLoading}
            className="btn btn-primary btn-sm"
          >
            {busy ? "Working…" : error ? "Try again" : "Confirm"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
