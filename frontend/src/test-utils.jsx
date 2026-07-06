import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthContext } from "./auth.jsx";

// A stand-in logged-in user for tests that just need to be "past the gate".
export const fakeUser = {
  pk: 1,
  email: "you@example.com",
  first_name: "",
  last_name: "",
  display_name: "you",
  bio: "",
  avatar_thumb: null,
  is_staff: false,
};

// Render `ui` inside a router, an auth context, and a fresh QueryClient (pages
// now fetch their data via TanStack Query). Retries are off so a rejected query
// surfaces its error state immediately instead of after backoff. Pass
// `auth: { user: null }` to simulate a logged-out visitor, or override any of
// the context callbacks.
export function renderWithAuth(ui, { route = "/", auth = {} } = {}) {
  const value = {
    user: fakeUser,
    loading: false,
    login: async () => {},
    logout: async () => {},
    register: async () => {},
    refreshUser: async () => fakeUser,
    ...auth,
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={value}>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>
  );
}
