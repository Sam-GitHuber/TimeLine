import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../api.js";
import { AuthShell, Field } from "./LoginPage.jsx";

// Forgotten-password reset (issue #38). Two phases on one page, mirroring the
// email-verification flow: first ask for the email and send a 6-digit code, then
// take that code plus a new password. We never reveal whether an address is a
// member — the "request" step always looks the same — so on submit we advance to
// the code step regardless (a code is only really sent to a real account).
//
// Reached from the login page's "Forgot password?" link (which passes the typed
// email in router state), or cold via /reset-password.
export default function ResetPasswordPage() {
  const location = useLocation();
  // "request" = enter email; "confirm" = enter code + new password.
  const [phase, setPhase] = useState("request");
  const [email, setEmail] = useState(location.state?.email || "");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const passwordsMismatch = confirm.length > 0 && password !== confirm;

  async function handleRequest(event) {
    event.preventDefault();
    setError(null);
    setNote(null);
    setSubmitting(true);
    try {
      await api.requestPasswordReset(email.trim());
      // Always advance — the response is deliberately identical whether or not
      // the address is a member, so the UI can't be used to probe either.
      setPhase("confirm");
      setNote(
        "If that email belongs to an account, we've sent a 6-digit reset code. " +
          "Enter it below with your new password."
      );
    } catch (err) {
      setError(err.message || "Could not start a password reset.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleConfirm(event) {
    event.preventDefault();
    setError(null);
    setNote(null);
    setSubmitting(true);
    try {
      await api.confirmPasswordReset(email.trim(), code.trim(), password, confirm);
      setDone(true);
    } catch (err) {
      setError(err.message || "Could not reset your password.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResend() {
    setError(null);
    setNote(null);
    setSubmitting(true);
    try {
      await api.requestPasswordReset(email.trim());
      setNote("If that email belongs to an account, we've sent a new code.");
    } catch (err) {
      setError(err.message || "Could not resend the code.");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <AuthShell title="Password reset">
        <p role="status" className="text-sm text-ink-soft">
          Your password has been reset. You can now log in with your new password.
        </p>
        <Link
          to="/login"
          state={{ email }}
          className="mt-6 block text-center text-sm font-medium text-accent-deep hover:underline"
        >
          Back to log in
        </Link>
      </AuthShell>
    );
  }

  if (phase === "request") {
    return (
      <AuthShell title="Reset your password">
        <form onSubmit={handleRequest} className="space-y-4">
          <p className="text-sm text-ink-soft">
            Enter your email address and we'll send you a 6-digit code to reset
            your password.
          </p>

          <Field
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            autoComplete="email"
            autoFocus
          />

          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || !email}
            className="btn btn-primary btn-block"
          >
            {submitting ? "Sending…" : "Send reset code"}
          </button>
        </form>

        <Link
          to="/login"
          className="mt-6 block text-center text-sm text-ink-faint hover:underline"
        >
          Back to log in
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Enter your reset code">
      <form onSubmit={handleConfirm} className="space-y-4">
        {note && (
          <p role="status" className="text-sm text-ink-soft">
            {note}
          </p>
        )}

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-soft">
            Reset code
          </span>
          <input
            value={code}
            onChange={(e) =>
              // Keep digits only, at most 6 — tolerant of a pasted "0 4 8 …".
              setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
            }
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            placeholder="••••••"
            autoFocus
            className="w-full rounded-xl border border-line-strong bg-raised px-3 py-3 text-center font-mono text-2xl tracking-[0.5em] text-ink transition placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-tint"
          />
        </label>

        <Field
          label="New password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
        />
        <Field
          label="Confirm new password"
          type="password"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
        />

        {passwordsMismatch && (
          <p className="text-sm text-red-600">The passwords don't match.</p>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={
            submitting ||
            code.length !== 6 ||
            !password ||
            !confirm ||
            passwordsMismatch
          }
          className="btn btn-primary btn-block"
        >
          {submitting ? "Resetting…" : "Reset password"}
        </button>
      </form>

      <div className="mt-6 text-center text-sm text-ink-faint">
        Didn't get it?{" "}
        <button
          type="button"
          onClick={handleResend}
          disabled={submitting || !email}
          className="font-medium text-accent-deep hover:underline disabled:opacity-50"
        >
          Resend code
        </button>
      </div>
      <Link
        to="/login"
        className="mt-4 block text-center text-sm text-ink-faint hover:underline"
      >
        Back to log in
      </Link>
    </AuthShell>
  );
}
