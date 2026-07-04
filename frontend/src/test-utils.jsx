import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthContext } from "./auth.jsx";

// A stand-in logged-in user for tests that just need to be "past the gate".
export const fakeUser = {
  pk: 1,
  email: "you@example.com",
  first_name: "",
  last_name: "",
};

// Render `ui` inside a router and an auth context, so protected pages render
// without going through the real (async, network-backed) AuthProvider. Pass
// `auth: { user: null }` to simulate a logged-out visitor, or override any of
// the context callbacks.
export function renderWithAuth(ui, { route = "/", auth = {} } = {}) {
  const value = {
    user: fakeUser,
    loading: false,
    login: async () => {},
    logout: async () => {},
    register: async () => {},
    ...auth,
  };
  return render(
    <AuthContext.Provider value={value}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </AuthContext.Provider>
  );
}
