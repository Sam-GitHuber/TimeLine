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
import { useMediaQuery } from "./hooks.js";
import { MessagingProvider, useMessaging } from "./messaging.jsx";
import { GroupsDrawerProvider, useGroupsDrawer } from "./groups-drawer.jsx";

// Below this width the two 400px companion drawers can't sit side-by-side, so
// opening one closes the other. Kept in sync with Layout.jsx's coordination.
const DRAWERS_DONT_FIT = "(max-width: 799px)";
import FeedPage from "./pages/FeedPage.jsx";
import PostPage from "./pages/PostPage.jsx";
import ProfilePage from "./pages/ProfilePage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";
import PeoplePage from "./pages/PeoplePage.jsx";
import GroupPage from "./pages/GroupPage.jsx";
import GroupFormPage from "./pages/GroupFormPage.jsx";
import GroupInvitesPage from "./pages/GroupInvitesPage.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import SignupPage from "./pages/SignupPage.jsx";
import VerifyEmailPage from "./pages/VerifyEmailPage.jsx";
import TermsPage from "./pages/legal/TermsPage.jsx";
import PrivacyPage from "./pages/legal/PrivacyPage.jsx";

// Route table:
//   /login, /signup   → public auth pages
//   /                 → the feed (home timeline)     ┐ require a logged-in user
//   /people           → people hub: Discover + Requests │ (ProtectedRoute gate)
//   /requests         → legacy → /people?tab=requests    │
//   /settings         → account & security settings    │
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
  const groupsDrawer = useGroupsDrawer();
  const tooNarrowForBoth = useMediaQuery(DRAWERS_DONT_FIT);
  const navigate = useNavigate();
  const { id } = useParams();
  useEffect(() => {
    // Same coordination as Layout's nav button: on a narrow viewport, opening
    // this drawer closes the other so they don't overlap.
    if (tooNarrowForBoth) groupsDrawer.close();
    if (thread && id) openThread(Number(id));
    else openList();
    navigate("/", { replace: true });
  }, [thread, id, openList, openThread, groupsDrawer, tooNarrowForBoth, navigate]);
  return null;
}

// Groups moved from a page to a left companion drawer (like messaging). The old
// `/groups` URL (bookmarks, history) still works: open the drawer over the feed,
// then replace the URL with `/`. `/g/:id`, `/groups/new` etc. stay real pages.
function GroupsRoute() {
  const { open } = useGroupsDrawer();
  const messaging = useMessaging();
  const tooNarrowForBoth = useMediaQuery(DRAWERS_DONT_FIT);
  const navigate = useNavigate();
  useEffect(() => {
    // Same coordination as Layout's nav button: on a narrow viewport, opening
    // this drawer closes the messages drawer so they don't overlap.
    if (tooNarrowForBoth) messaging.close();
    open();
    navigate("/", { replace: true });
  }, [open, messaging, tooNarrowForBoth, navigate]);
  return null;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      {/* Email verification (issue #73) — reached after sign-up, or from login
          when an unverified account tries to log in. Public (no session yet). */}
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      {/* Legal pages — public so they're reachable from sign-up (before login)
          as well as from the in-app footer. */}
      <Route path="/terms" element={<TermsPage />} />
      <Route path="/privacy" element={<PrivacyPage />} />

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
          {/* Post permalink — where notifications deep-link (optionally with
              ?comment=<id> to open the thread at a specific reply). */}
          <Route path="p/:id" element={<PostPage />} />
          <Route path="people" element={<PeoplePage />} />
          {/* Requests folded into the People hub as a tab; the old URL still
              works, landing on that tab. */}
          <Route
            path="requests"
            element={<Navigate to="/people?tab=requests" replace />}
          />
          {/* Account & security controls. Profile editing moved in-place onto
              your own profile page (issue #53). */}
          <Route path="settings" element={<SettingsPage />} />
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
