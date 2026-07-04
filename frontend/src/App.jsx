import { useEffect, useState } from "react";

// The browser talks to the backend via the port published on the host, so this
// is localhost:8000 (not the "backend" docker service name). Override with the
// VITE_API_URL env var if needed.
const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

export default function App() {
  const [status, setStatus] = useState("loading"); // loading | ok | error
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch(`${API_URL}/api/hello`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => {
        setData(json);
        setStatus("ok");
      })
      .catch((err) => {
        setError(err.message);
        setStatus("error");
      });
  }, []);

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 p-8">
        <h1 className="text-2xl font-semibold tracking-tight">TimeLine</h1>
        <p className="mt-1 text-sm text-slate-500">Phase 0 — stack smoke test</p>

        <div className="mt-6 rounded-xl bg-slate-50 ring-1 ring-slate-200 p-4">
          {status === "loading" && (
            <p className="text-slate-500">Contacting the backend…</p>
          )}

          {status === "ok" && (
            <div>
              <p className="flex items-center gap-2 font-medium text-emerald-600">
                <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
                Backend connected
              </p>
              <p className="mt-2 text-slate-800">{data.message}</p>
              <p className="mt-1 text-xs text-slate-400">
                server time: {data.time}
              </p>
            </div>
          )}

          {status === "error" && (
            <div>
              <p className="flex items-center gap-2 font-medium text-red-600">
                <span className="inline-block h-2 w-2 rounded-full bg-red-500" />
                Could not reach backend
              </p>
              <p className="mt-2 text-sm text-slate-600">
                Tried <code className="text-slate-800">{API_URL}/api/hello</code>
              </p>
              <p className="mt-1 text-xs text-slate-400">{error}</p>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
