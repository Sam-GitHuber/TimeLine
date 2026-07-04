import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout.jsx";
import ProtectedRoute from "./components/ProtectedRoute.jsx";
import FeedPage from "./pages/FeedPage.jsx";
import ProfilePage from "./pages/ProfilePage.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import SignupPage from "./pages/SignupPage.jsx";

// Route table:
//   /login, /signup   → public auth pages
//   /                 → the feed (home timeline)     ┐ require a logged-in user
//   /u/:username      → a person's profile           ┘ (ProtectedRoute gate)
// The protected pages render inside Layout, which provides the nav bar (with
// the logout control) and the shared posts state. Real URLs (not just tab
// state) mean the back button and shareable links work.
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />

      <Route element={<ProtectedRoute />}>
        <Route path="/" element={<Layout />}>
          <Route index element={<FeedPage />} />
          <Route path="u/:username" element={<ProfilePage />} />
        </Route>
      </Route>
    </Routes>
  );
}
