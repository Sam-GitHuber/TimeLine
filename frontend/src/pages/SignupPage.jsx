import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth.jsx";
import { AuthShell, Field } from "./LoginPage.jsx";

// Sign-up form. On success the account exists but is *pending admin approval*
// and cannot log in yet — so instead of logging the user in, we show them that
// pending message.
export default function SignupPage() {
  const { register } = useAuth();

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingMessage, setPendingMessage] = useState(null);

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("The two passwords don't match.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await register(
        email,
        password,
        firstName,
        lastName,
        acceptTerms
      );
      setPendingMessage(
        result?.detail ||
          "Account created and pending approval. You'll be able to log in once the site owner approves your account."
      );
    } catch (err) {
      setError(err.message || "Could not create the account.");
    } finally {
      setSubmitting(false);
    }
  }

  if (pendingMessage) {
    return (
      <AuthShell title="Almost there">
        <p role="status" className="text-sm text-ink-soft">
          {pendingMessage}
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
    <AuthShell title="Create your account">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="flex gap-3">
          <Field
            label="First name"
            value={firstName}
            onChange={setFirstName}
            autoComplete="given-name"
            autoFocus
          />
          <Field
            label="Last name"
            value={lastName}
            onChange={setLastName}
            autoComplete="family-name"
          />
        </div>
        <Field
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
        />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
        />
        <Field
          label="Confirm password"
          type="password"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
        />

        <label className="flex items-start gap-2 text-sm text-ink-soft">
          <input
            type="checkbox"
            checked={acceptTerms}
            onChange={(e) => setAcceptTerms(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-line-strong text-accent focus:ring-2 focus:ring-accent-tint"
          />
          <span>
            I agree to the{" "}
            <Link
              to="/terms"
              target="_blank"
              className="font-medium text-accent-deep hover:underline"
            >
              Terms of Service
            </Link>{" "}
            and{" "}
            <Link
              to="/privacy"
              target="_blank"
              className="font-medium text-accent-deep hover:underline"
            >
              Privacy Policy
            </Link>
            .
          </span>
        </label>

        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={
            submitting ||
            !firstName ||
            !lastName ||
            !email ||
            !password ||
            !confirm ||
            !acceptTerms
          }
          className="btn btn-primary btn-block"
        >
          {submitting ? "Creating…" : "Sign up"}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-ink-faint">
        Already have an account?{" "}
        <Link to="/login" className="font-medium text-accent-deep hover:underline">
          Log in
        </Link>
      </p>
    </AuthShell>
  );
}
