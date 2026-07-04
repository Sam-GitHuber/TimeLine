import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout.jsx";
import FeedPage from "./pages/FeedPage.jsx";
import ProfilePage from "./pages/ProfilePage.jsx";

// Route table for the wireframe:
//   /            → the feed (home timeline)
//   /u/:username → a person's profile
// Both render inside Layout, which provides the nav bar and the shared posts
// state. Real URLs (not just tab state) mean the back button and shareable
// links work — and it's the same router we'll lean on more in later phases.
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<FeedPage />} />
        <Route path="u/:username" element={<ProfilePage />} />
      </Route>
    </Routes>
  );
}
