import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth.jsx";
import { AuthShell, Field } from "./LoginPage.jsx";

// Sign-up form. On success the account exists but must be verified (email code)
// and then approved by the site owner before it can log in — so instead of
// logging the user in, we send them to the verify-email step, carrying their
// address so the code entry is pre-addressed.
export default function SignupPage() {
  const { register } = useAuth();
  const navigate = useNavigate();

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("The two passwords don't match.");
      return;
    }
    setSubmitting(true);
    try {
      await register(email, password, firstName, lastName, acceptTerms);
      // Off to enter the 6-digit code. Pass the email so the verify page is
      // pre-addressed (the code entry is the only thing left to do there).
      navigate("/verify-email", { state: { email } });
    } catch (err) {
      setError(err.message || "Could not create the account.");
      setSubmitting(false);
    }
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
