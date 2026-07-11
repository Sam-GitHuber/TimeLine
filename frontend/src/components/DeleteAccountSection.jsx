import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api.js";

// The "danger zone" on the profile-edit page: permanently delete your account
// and everything you've posted (UK GDPR erasure — Phase 7). Because it's
// irreversible, the confirm modal makes you re-enter your password; the backend
// re-checks it. On success the session is dead, so we clear the auth cookie
// (best-effort) and hard-reload to the login page for a clean, logged-out boot.
export default function DeleteAccountSection() {
  const [confirming, setConfirming] = useState(false);

  return (
    <section className="mt-10 border-t border-line pt-6">
      <h2 className="font-display text-lg font-semibold -tracking-[0.01em] text-red-700">
        Delete account
      </h2>
      <p className="mt-1 text-sm text-ink-soft">
        Permanently delete your account and everything you’ve posted — your
        posts, photos, comments and messages. This can’t be undone.
      </p>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="btn btn-sm mt-3 border border-red-300 bg-transparent text-red-700 hover:bg-red-50"
      >
        Delete my account…
      </button>

      {confirming && (
        <ConfirmDeleteModal onCancel={() => setConfirming(false)} />
      )}
    </section>
  );
}

function ConfirmDeleteModal({ onCancel }) {
  const dialogRef = useRef(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [deleting, setDeleting] = useState(false);

  // Esc cancels; lock background scroll and move focus in — same dialog pattern
  // as DisconnectWarningModal.
  useEffect(() => {
    function onKey(event) {
      if (event.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  async function handleDelete(event) {
    event.preventDefault();
    if (deleting || !password) return;
    setError(null);
    setDeleting(true);
    try {
      await api.deleteAccount(password);
      // The account (and session) is gone. Clear the auth cookie best-effort,
      // then hard-reload to /login so the whole app re-boots logged-out with no
      // stale cache.
      try {
        await api.logout();
      } catch {
        // Session already invalid — nothing to clear.
      }
      window.location.assign("/login");
    } catch (err) {
      setError(err.message || "Couldn’t delete your account.");
      setDeleting(false);
    }
  }

  const stop = (event) => event.stopPropagation();

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4 backdrop-blur-sm"
      onClick={onCancel}
    >
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Delete account confirmation"
        tabIndex={-1}
        onClick={stop}
        onSubmit={handleDelete}
        className="w-full max-w-sm rounded-2xl border border-line bg-raised p-5 shadow-xl outline-none"
      >
        <h2 className="font-display text-lg font-semibold text-ink">
          Delete your account?
        </h2>
        <p className="mt-2 text-sm text-ink-soft">
          This permanently deletes your account and all your content. It can’t be
          undone. Enter your password to confirm.
        </p>

        <label className="mt-4 block">
          <span className="mb-1 block text-sm font-medium text-ink-soft">
            Password
          </span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            autoFocus
            className="w-full rounded-xl border border-line-strong bg-raised px-3 py-2 text-ink transition focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-tint"
          />
        </label>

        {error && (
          <p role="alert" className="mt-3 text-sm text-red-600">
            {error}
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
            type="submit"
            disabled={deleting || !password}
            className="btn btn-sm bg-red-600 text-white hover:bg-red-700"
          >
            {deleting ? "Deleting…" : "Delete forever"}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}
