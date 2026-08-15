import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App.jsx";
import { AuthProvider } from "./auth.jsx";
import { AppErrorBoundary } from "./components/ErrorBoundary.jsx";
import "./index.css";

// One QueryClient for the whole app. TanStack Query handles loading/refetching
// of feed and people data (see docs/SHARED.md — added when the frontend first
// talks to the real API in Phase 3). Defaults are fine for our needs.
const queryClient = new QueryClient();

// Where the error boundary sits, and why it's *here* rather than one level in
// or one level out (issue #299):
//
//   - **Inside `QueryClientProvider`**, so a future fallback could read the
//     cache, and so the reset path below it has a client to talk to at all.
//   - **Outside `BrowserRouter`**, because this is the boundary of last resort:
//     it has to survive a crash *in* the router or in `AuthProvider`, which a
//     boundary underneath them would go down with. The cost is that its
//     fallback can't navigate — hence the full page load it offers instead.
//   - **Inside `StrictMode`**, which matters only in development: Strict Mode
//     deliberately re-invokes a failed render, so a caught error is reported
//     twice in the console. That's Strict Mode being loud, not the boundary
//     catching twice.
//
// The boundary that does the useful day-to-day work is the *other* one, around
// the router outlet in `components/Layout.jsx` — a crash in a page leaves the
// nav alive, so nobody has to reload. This one only catches what escapes that.
createRoot(document.getElementById("root")).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AppErrorBoundary>
        <BrowserRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </AppErrorBoundary>
    </QueryClientProvider>
  </StrictMode>
);
