import { useEffect } from "react";
import {
  Navigate,
  Routes,
  Route,
  useNavigate,
  useParams,
} from "react-router-dom";
import Layout from "./components/Layout.jsx";
import ProtectedRoute from "./components/ProtectedRoute.jsx";
import { MessagingProvider, useMessaging } from "./messaging.jsx";
import { GroupsDrawerProvider, useGroupsDrawer } from "./groups-drawer.jsx";
import FeedPage from "./pages/FeedPage.jsx";
import ProfilePage from "./pages/ProfilePage.jsx";
import ProfileEditPage from "./pages/ProfileEditPage.jsx";
import FindPeoplePage from "./pages/FindPeoplePage.jsx";
import RequestsPage from "./pages/RequestsPage.jsx";
import GroupPage from "./pages/GroupPage.jsx";
import GroupFormPage from "./pages/GroupFormPage.jsx";
import GroupInvitesPage from "./pages/GroupInvitesPage.jsx";
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
//
// Messaging isn't a route: it's a companion drawer (Layout renders it) driven by
// MessagingProvider state, so opening it never unmounts the feed underneath —
// you keep your scroll position. See components/MessagesDrawer.jsx.
//
// But the old `/messages` and `/messages/:id` URLs (bookmarks, browser history,
// shared conversation links) must still work: MessagesRoute honours them by
// opening the drawer over the feed, then replacing the URL with `/`.
function MessagesRoute({ thread = false }) {
  const { openList, openThread } = useMessaging();
  const navigate = useNavigate();
  const { id } = useParams();
  useEffect(() => {
    if (thread && id) openThread(Number(id));
    else openList();
    navigate("/", { replace: true });
  }, [thread, id, openList, openThread, navigate]);
  return null;
}

// Groups moved from a page to a left companion drawer (like messaging). The old
// `/groups` URL (bookmarks, history) still works: open the drawer over the feed,
// then replace the URL with `/`. `/g/:id`, `/groups/new` etc. stay real pages.
function GroupsRoute() {
  const { open } = useGroupsDrawer();
  const navigate = useNavigate();
  useEffect(() => {
    open();
    navigate("/", { replace: true });
  }, [open, navigate]);
  return null;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />

      <Route element={<ProtectedRoute />}>
        <Route
          path="/"
          element={
            <MessagingProvider>
              <GroupsDrawerProvider>
                <Layout />
              </GroupsDrawerProvider>
            </MessagingProvider>
          }
        >
          <Route index element={<FeedPage />} />
          <Route path="people" element={<FindPeoplePage />} />
          <Route path="requests" element={<RequestsPage />} />
          <Route path="settings" element={<ProfileEditPage />} />
          <Route path="u/:id" element={<ProfilePage />} />
          {/* Groups (Phase 6) — the list is a left companion drawer, not a
              page; legacy `/groups` opens it. The rest stay real pages. */}
          <Route path="groups" element={<GroupsRoute />} />
          <Route path="groups/new" element={<GroupFormPage />} />
          <Route path="group-invites" element={<GroupInvitesPage />} />
          <Route path="g/:id" element={<GroupPage />} />
          <Route path="g/:id/edit" element={<GroupFormPage />} />
          {/* Legacy/deep-link messaging URLs → open the drawer over the feed. */}
          <Route path="messages" element={<MessagesRoute />} />
          <Route path="messages/:id" element={<MessagesRoute thread />} />
          {/* Anything else lands on the feed rather than a blank screen. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}
