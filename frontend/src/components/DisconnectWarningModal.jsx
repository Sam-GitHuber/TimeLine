import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";

// Disconnecting/blocking someone severs any *group* chats you only share
// through that connection — you're dropped to pending in them until you
// reconnect with everyone else there. Before ConnectButton/BlockButton fire
// the actual mutation, this fetches that impact and, if it's non-empty, makes
// the caller read the list and explicitly confirm. Modelled on Lightbox.jsx's
// dialog pattern (portal, role="dialog", focus management, Esc-to-cancel).
export default function DisconnectWarningModal({
  userId,
  userName,
  action,
  onConfirm,
  onCancel,
}) {
  const dialogRef = useRef(null);

  const impactQuery = useQuery({
    queryKey: ["disconnect-impact", userId],
    queryFn: () => api.getDisconnectImpact(userId),
  });

  // Esc cancels, like every other dialog in the app.
  useEffect(() => {
    function onKey(event) {
      if (event.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // Lock background scroll, move focus into the dialog, restore it on close.
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

  const chats = impactQuery.data?.chats ?? [];
  const hasImpact = chats.length > 0;
  const verb = action === "block" ? "Blocking" : "Disconnecting from";
  const label = action === "block" ? "Block" : "Disconnect";

  // Stop clicks inside the card from bubbling to the backdrop (which cancels).
  const stop = (event) => event.stopPropagation();

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4 backdrop-blur-sm"
      onClick={onCancel}
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

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="btn btn-ghost btn-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={impactQuery.isLoading}
            className="btn btn-primary btn-sm"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
