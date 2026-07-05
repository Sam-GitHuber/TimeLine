import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth.jsx";

// Log-in form. On success, send the user back to wherever they were trying to
// go (ProtectedRoute stashes that in location.state.from), or the feed.
export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from?.pathname || "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err.message || "Could not log in.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell title="Log in to TimeLine">
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
          autoComplete="current-password"
        />

        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting || !email || !password}
          className="btn btn-primary btn-block"
        >
          {submitting ? "Logging in…" : "Log in"}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-ink-faint">
        No account?{" "}
        <Link to="/signup" className="font-medium text-accent-deep hover:underline">
          Sign up
        </Link>
      </p>
    </AuthShell>
  );
}

// --- Small shared building blocks for the two auth pages -------------------

export function AuthShell({ title, children }) {
  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 flex items-center justify-center gap-2 font-display text-2xl font-bold -tracking-[0.02em] text-ink">
          <svg width="16" height="20" viewBox="0 0 16 20" fill="none" aria-hidden="true">
            <line
              x1="8"
              y1="2"
              x2="8"
              y2="18"
              stroke="var(--color-spine)"
              strokeWidth="2"
              strokeLinecap="round"
            />
            <circle cx="8" cy="6" r="4" fill="var(--color-accent)" />
          </svg>
          TimeLine
        </h1>
        <h2 className="mb-6 text-center text-sm text-ink-faint">{title}</h2>
        <div className="rounded-2xl border border-line bg-raised p-6 shadow-[0_2px_4px_rgba(28,26,22,0.05),0_18px_40px_-14px_rgba(28,26,22,0.14)]">
          {children}
        </div>
      </div>
    </div>
  );
}

export function Field({ label, value, onChange, ...props }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink-soft">
        {label}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-line-strong bg-raised px-3 py-2 text-ink transition focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-tint"
        {...props}
      />
    </label>
  );
}
