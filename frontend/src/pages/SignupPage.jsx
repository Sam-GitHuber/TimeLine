import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth.jsx";
import { AuthShell, Field } from "./LoginPage.jsx";

// Sign-up form. On success the account exists but is *pending admin approval*
// and cannot log in yet — so instead of logging the user in, we show them that
// pending message.
export default function SignupPage() {
  const { register } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
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
      const result = await register(email, password);
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
        <p role="status" className="text-sm text-slate-700">
          {pendingMessage}
        </p>
        <Link
          to="/login"
          className="mt-6 block text-center text-sm font-medium text-sky-700 hover:underline"
        >
          Back to log in
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Create your account">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
          autoFocus
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

        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting || !email || !password || !confirm}
          className="w-full rounded-full bg-sky-600 px-5 py-2 font-semibold text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? "Creating…" : "Sign up"}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-slate-500">
        Already have an account?{" "}
        <Link to="/login" className="font-medium text-sky-700 hover:underline">
          Log in
        </Link>
      </p>
    </AuthShell>
  );
}
