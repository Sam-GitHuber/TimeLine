import { useState } from "react";
import { api } from "../api.js";

// A "Change password" section on the profile-edit page (Phase 7 account hygiene).
// The current password is required — both because the backend enforces it and so
// a shoulder-surfer at an unlocked screen (or a hijacked session) can't lock the
// owner out. It's not destructive, so — unlike DeleteAccountSection — it's an
// inline expanding form rather than a confirm modal. On success the session
// stays valid; we just confirm and clear the fields.
export default function ChangePasswordSection() {
  const [open, setOpen] = useState(false);

  return (
    <section className="mt-10 border-t border-line pt-6">
      <h2 className="font-display text-lg font-semibold -tracking-[0.01em] text-ink">
        Change password
      </h2>
      <p className="mt-1 text-sm text-ink-soft">
        Update the password you use to sign in. You’ll need your current one.
      </p>

      {open ? (
        <ChangePasswordForm onDone={() => setOpen(false)} />
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="btn btn-ghost btn-sm mt-3"
        >
          Change password…
        </button>
      )}
    </section>
  );
}

function ChangePasswordForm({ onDone }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);

  // Cheap client-side guard so an obvious mismatch doesn't need a round-trip;
  // the backend re-checks everything regardless.
  const mismatch = confirm.length > 0 && next !== confirm;
  const canSubmit = current && next && confirm && !mismatch && !saving;

  async function handleSubmit(event) {
    event.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setSaving(true);
    try {
      await api.changePassword(current, next, confirm);
      setDone(true);
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      setError(err.message || "Couldn’t change your password.");
    } finally {
      setSaving(false);
    }
  }

  const field =
    "w-full rounded-xl border border-line-strong bg-raised px-3 py-2 text-ink transition focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-tint";

  return (
    <form onSubmit={handleSubmit} className="mt-4 max-w-sm space-y-4">
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-ink-soft">
          Current password
        </span>
        <input
          type="password"
          value={current}
          onChange={(e) => {
            setCurrent(e.target.value);
            setDone(false);
          }}
          autoComplete="current-password"
          className={field}
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-ink-soft">
          New password
        </span>
        <input
          type="password"
          value={next}
          onChange={(e) => {
            setNext(e.target.value);
            setDone(false);
          }}
          autoComplete="new-password"
          className={field}
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-ink-soft">
          Confirm new password
        </span>
        <input
          type="password"
          value={confirm}
          onChange={(e) => {
            setConfirm(e.target.value);
            setDone(false);
          }}
          autoComplete="new-password"
          className={field}
        />
      </label>

      {mismatch && (
        <p className="text-sm text-red-600">The new passwords don’t match.</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="text-sm text-accent-deep">
          Your password has been changed.
        </p>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onDone}
          className="btn btn-ghost btn-sm"
        >
          Close
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          className="btn btn-primary btn-sm"
        >
          {saving ? "Saving…" : "Change password"}
        </button>
      </div>
    </form>
  );
}
