import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../api.js";
import { AuthShell, Field } from "./LoginPage.jsx";

// Email verification step. Sign-up sends a 6-digit code to the new address; the
// person types (or pastes) it here to prove they control the inbox. Verifying
// only proves address control — the account still needs the site owner's
// approval before it can log in (see docs/reference/accounts.md).
//
// We arrive here either straight after sign-up (with the email in router state)
// or from the login page when an unverified account tries to log in. If we don't
// know the email (e.g. a cold page load), we ask for it.
export default function VerifyEmailPage() {
  const location = useLocation();
  const [email, setEmail] = useState(location.state?.email || "");
  const [code, setCode] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [verified, setVerified] = useState(false);
  // The generic "we've sent a code" acknowledgement after a resend.
  const [resendNote, setResendNote] = useState(null);
  const [resending, setResending] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setResendNote(null);
    setSubmitting(true);
    try {
      await api.verifyEmail(email.trim(), code.trim());
      setVerified(true);
    } catch (err) {
      setError(err.message || "Could not verify that code.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResend() {
    setError(null);
    setResendNote(null);
    setResending(true);
    try {
      const result = await api.resendVerification(email.trim());
      setResendNote(
        result?.detail ||
          "If that address still needs verifying, we've sent a new code."
      );
    } catch (err) {
      setError(err.message || "Could not resend the code.");
    } finally {
      setResending(false);
    }
  }

  if (verified) {
    return (
      <AuthShell title="Email verified">
        <p role="status" className="text-sm text-ink-soft">
          Thanks — your email address is verified. Your account is now awaiting
          the site owner's approval. We'll let you in once it's approved.
        </p>
        <Link
          to="/login"
          className="mt-6 block text-center text-sm font-medium text-accent-deep hover:underline"
        >
          Back to log in
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Verify your email">
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm text-ink-soft">
          We've emailed a 6-digit code to
          {email ? (
            <>
              {" "}
              <span className="font-medium text-ink">{email}</span>.
            </>
          ) : (
            " your address."
          )}{" "}
          Enter it below to verify your address.
        </p>

        {/* If we didn't arrive with the email (cold load), let them supply it. */}
        {!location.state?.email && (
          <Field
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            autoComplete="email"
          />
        )}

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-soft">
            Verification code
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

        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        {resendNote && (
          <p role="status" className="text-sm text-ink-soft">
            {resendNote}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting || code.length !== 6 || !email}
          className="btn btn-primary btn-block"
        >
          {submitting ? "Verifying…" : "Verify"}
        </button>
      </form>

      <div className="mt-6 text-center text-sm text-ink-faint">
        Didn't get it?{" "}
        <button
          type="button"
          onClick={handleResend}
          disabled={resending || !email}
          className="font-medium text-accent-deep hover:underline disabled:opacity-50"
        >
          {resending ? "Sending…" : "Resend code"}
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
