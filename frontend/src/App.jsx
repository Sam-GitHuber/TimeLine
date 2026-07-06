import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout.jsx";
import ProtectedRoute from "./components/ProtectedRoute.jsx";
import FeedPage from "./pages/FeedPage.jsx";
import ProfilePage from "./pages/ProfilePage.jsx";
import ProfileEditPage from "./pages/ProfileEditPage.jsx";
import FindPeoplePage from "./pages/FindPeoplePage.jsx";
import RequestsPage from "./pages/RequestsPage.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import SignupPage from "./pages/SignupPage.jsx";

// Route table:
//   /login, /signup   → public auth pages
//   /                 → the feed (home timeline)     ┐ require a logged-in user
//   /people           → find people to connect with  │ (ProtectedRoute gate)
//   /requests         → incoming connection requests  │
//   /settings         → edit your own profile          │
//   /u/:id            → a person's profile (by user id) ┘
// The protected pages render inside Layout, which provides the nav bar (with
// the logout control). Each page fetches its own data from the API. Real URLs
// (not just tab state) mean the back button and shareable links work.
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />

      <Route element={<ProtectedRoute />}>
        <Route path="/" element={<Layout />}>
          <Route index element={<FeedPage />} />
          <Route path="people" element={<FindPeoplePage />} />
          <Route path="requests" element={<RequestsPage />} />
          <Route path="settings" element={<ProfileEditPage />} />
          <Route path="u/:id" element={<ProfilePage />} />
        </Route>
      </Route>
    </Routes>
  );
}
