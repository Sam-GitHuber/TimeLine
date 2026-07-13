// Thin wrapper around fetch for talking to the Django API.
//
// Two things every call needs in our cookie-based auth setup:
//   - credentials: "include" — so the browser sends (and stores) our httpOnly
//     auth cookie. Without it, fetch ignores cookies cross-origin.
//   - the CSRF token — mutating requests must echo the `csrftoken` cookie back
//     in the X-CSRFToken header (the backend enforces this whenever the auth
//     cookie is present). GET requests don't need it.
//
// The auth token itself lives in an httpOnly cookie we deliberately can't read
// from JavaScript, so there's nothing here that stores or reads it — the
// browser attaches it automatically.

const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

// Near-real-time messaging is done by polling for now, not WebSockets (see
// docs/reference/messaging.md — the swap to Channels later is deliberately
// non-breaking). These are the one place the cadences live, so "go real-time"
// is a localised change: an open thread refreshes briskly; the list + nav badge
// tick more slowly.
export const MESSAGE_POLL_MS = 4000;
export const CONVERSATION_LIST_POLL_MS = 12000;
// The activity-centre bell polls its unread count on the same slow cadence as
// the conversation list — a notification isn't more urgent than a message, and
// this keeps the nav badges ticking in step. Same non-breaking swap-to-Channels
// note as messaging applies (docs/phases/phase-8-notifications.md).
export const NOTIFICATIONS_POLL_MS = 12000;

function getCookie(name) {
  const match = document.cookie.match(
    new RegExp("(?:^|; )" + name + "=([^;]*)")
  );
  return match ? decodeURIComponent(match[1]) : null;
}

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

async function request(path, { method = "GET", body } = {}) {
  // A FormData body means a file upload (post photos, avatar). Let the browser
  // set the multipart Content-Type (with its boundary) — setting it ourselves
  // would omit the boundary and the server couldn't parse the parts. JSON
  // bodies still get an explicit application/json header.
  const isFormData =
    typeof FormData !== "undefined" && body instanceof FormData;
  const headers = {};
  if (body !== undefined && !isFormData) {
    headers["Content-Type"] = "application/json";
  }
  // Only unsafe methods are CSRF-checked; sending it always is harmless.
  if (method !== "GET" && method !== "HEAD") {
    const csrf = getCookie("csrftoken");
    if (csrf) headers["X-CSRFToken"] = csrf;
  }

  const response = await fetch(BASE_URL + path, {
    method,
    headers,
    credentials: "include",
    body:
      body === undefined
        ? undefined
        : isFormData
          ? body
          : JSON.stringify(body),
  });

  // 204 No Content (and empty bodies) have nothing to parse.
  let data = null;
  const text = await response.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    throw new ApiError(
      firstErrorMessage(data) || `Request failed (${response.status})`,
      response.status,
      data
    );
  }
  return data;
}

// DRF returns validation errors as { field: ["msg", ...] } or
// { detail: "msg" } / { non_field_errors: [...] }. Pull out something showable.
function firstErrorMessage(data) {
  if (!data || typeof data !== "object") return null;
  if (typeof data.detail === "string") return data.detail;
  const firstKey = Object.keys(data)[0];
  if (!firstKey) return null;
  const value = data[firstKey];
  return Array.isArray(value) ? value[0] : String(value);
}

export const api = {
  ApiError,

  // Prime the csrftoken cookie. Call once on app load, before any mutation.
  ensureCsrf: () => request("/api/auth/csrf/"),

  // "Who am I" — resolves to the user, or throws (401) when logged out.
  getCurrentUser: () => request("/api/auth/user/"),

  login: (email, password) =>
    request("/api/auth/login/", { method: "POST", body: { email, password } }),

  logout: () => request("/api/auth/logout/", { method: "POST" }),

  // Registration creates a *pending* account; it does not log you in. We collect
  // the real name here (there are no usernames), so an approved account has a
  // display name from day one.
  register: (email, password, firstName, lastName, acceptTerms = false) =>
    request("/api/auth/registration/", {
      method: "POST",
      body: {
        email,
        password1: password,
        password2: password,
        first_name: firstName,
        last_name: lastName,
        // Explicit consent to the Terms + privacy policy — required by the
        // backend to create the account (it records when you agreed).
        accept_terms: acceptTerms,
      },
    }),

  // Update your own profile (name, bio, avatar) via dj-rest-auth's user
  // endpoint. Sent as multipart because it can carry an avatar file. Pass
  // `removeAvatar: true` to clear an existing avatar.
  updateProfile: ({ first_name, last_name, bio, avatar, removeAvatar } = {}) => {
    const form = new FormData();
    if (first_name !== undefined) form.append("first_name", first_name);
    if (last_name !== undefined) form.append("last_name", last_name);
    if (bio !== undefined) form.append("bio", bio);
    if (avatar) form.append("avatar", avatar);
    if (removeAvatar) form.append("remove_avatar", "true");
    return request("/api/auth/user/", { method: "PATCH", body: form });
  },

  // Change your own password while logged in (dj-rest-auth). The current
  // password is required (the backend enforces it — see OLD_PASSWORD_FIELD_ENABLED),
  // so a hijacked session can't silently rotate it. The confirm field is checked
  // server-side too. On success the session stays valid — no re-login needed.
  changePassword: (currentPassword, newPassword, confirmPassword) =>
    request("/api/auth/password/change/", {
      method: "POST",
      body: {
        old_password: currentPassword,
        new_password1: newPassword,
        new_password2: confirmPassword,
      },
    }),

  // Permanently delete your own account and all your data. Password-reconfirmed
  // (the backend rejects a wrong password) because it's irreversible. On success
  // the server returns 204 and the session is dead; the caller clears local state.
  deleteAccount: (password) =>
    request("/api/account/delete/", {
      method: "POST",
      body: { password },
    }),

  // Report a post or comment for the maintainer to review (Phase 7 takedown
  // path). Pass exactly one of postId / commentId, plus an optional reason.
  reportContent: ({ postId = null, commentId = null, reason = "" } = {}) =>
    request("/api/reports/", {
      method: "POST",
      body: {
        ...(postId ? { post: postId } : {}),
        ...(commentId ? { comment: commentId } : {}),
        reason,
      },
    }),

  // --- Timeline (Phase 3) --------------------------------------------------

  // The home feed: your posts + everyone you're connected with, newest-first,
  // paginated. Pass `includeGroups` to also merge in posts from groups you're a
  // member of, still strictly chronological (opt-in — off by default so the feed
  // stays "my connections" unless you ask for more).
  getFeed: ({ includeGroups = false } = {}) =>
    request(`/api/feed/${includeGroups ? "?include_groups=1" : ""}`),

  // Follow a paginated response's `next` URL. DRF returns an absolute URL built
  // from the request host, which needn't match BASE_URL (behind a proxy, or a
  // separate API domain in prod). Take just the path + query so request()
  // prepends our own BASE_URL regardless of the origin DRF used.
  getPage: (nextUrl) => {
    const url = new URL(nextUrl, BASE_URL);
    return request(url.pathname + url.search);
  },

  // Create a post. With no photos (and no group) it's a plain JSON body; with
  // photos it becomes a multipart upload carrying the text plus each image file
  // under `images`. Pass a `group` id to post into that group's timeline instead
  // of your personal one (the backend checks you're a member).
  createPost: (text, images = [], group = null) => {
    if ((!images || images.length === 0) && !group) {
      return request("/api/posts/", { method: "POST", body: { text } });
    }
    const form = new FormData();
    if (text) form.append("text", text);
    for (const file of images) form.append("images", file);
    if (group) form.append("group", group);
    return request("/api/posts/", { method: "POST", body: form });
  },

  // A single post by id — the permalink endpoint (`/p/:id`). Gated the same as
  // every post surface; a post you can't see 404s.
  getPost: (id) => request(`/api/posts/${id}/`),

  // The visible comment tree for a post (already pruned server-side to people
  // you're connected with), and adding a comment/reply.
  getComments: (postId) => request(`/api/posts/${postId}/comments/`),

  addComment: (postId, { text, parent = null }) =>
    request(`/api/posts/${postId}/comments/`, {
      method: "POST",
      body: parent ? { text, parent } : { text },
    }),

  // --- Reactions (Phase 7b) ------------------------------------------------

  // Toggle your emoji reaction on a post or comment: adds it, or removes it if
  // you'd already used that emoji. Returns the target's fresh, viewer-pruned
  // reaction summary (`{ reactions: [{ emoji, count, reacted }] }`). Pass
  // exactly one of postId / commentId.
  toggleReaction: ({ postId = null, commentId = null, emoji }) =>
    request(
      postId
        ? `/api/posts/${postId}/react/`
        : `/api/comments/${commentId}/react/`,
      { method: "POST", body: { emoji } },
    ),

  // Who reacted, grouped by emoji (pruned to people you may see) — for the
  // "who reacted" popover. Pass exactly one of postId / commentId.
  getReactors: ({ postId = null, commentId = null }) =>
    request(
      postId
        ? `/api/posts/${postId}/reactions/`
        : `/api/comments/${commentId}/reactions/`,
    ),

  // People to connect with — everyone else, each with your connection_status.
  listUsers: () => request("/api/users/"),

  // Just the people you're already connected with — the People hub's
  // "Connections" tab, a quick directory to reach a friend's profile. Same
  // shape as listUsers (so pagination/rows are identical), narrowed server-side.
  listConnections: () => request("/api/users/?filter=connected"),

  // People you're *not* yet connected with — the "Discover" tab. Excludes your
  // existing connections (they live on the Connections tab), so Discover stays a
  // "find new people" view. Pending/incoming requests still appear here.
  listDiscover: () => request("/api/users/?filter=discover"),

  getUser: (id) => request(`/api/users/${id}/`),

  getUserPosts: (id) => request(`/api/users/${id}/posts/`),

  // Connections are private + mutual: this sends a *request* the other person
  // must approve (or, if they already requested you, it accepts theirs).
  connect: (id) => request(`/api/users/${id}/connect/`, { method: "POST" }),

  // Cancels a pending request or ends an accepted connection (same endpoint).
  disconnect: (id) => request(`/api/users/${id}/connect/`, { method: "DELETE" }),

  // Incoming connection requests (people asking to connect) + approve/reject.
  getConnectionRequests: () => request("/api/connection-requests/"),

  approveRequest: (id) =>
    request(`/api/connection-requests/${id}/approve/`, { method: "POST" }),

  rejectRequest: (id) =>
    request(`/api/connection-requests/${id}/reject/`, { method: "POST" }),

  // --- Direct messaging (Phase 5) ------------------------------------------

  // Your conversations, most-recent-activity first, each with the other person,
  // a last-message preview, and your unread count. Paginated.
  getConversations: () => request("/api/conversations/"),

  // Get-or-create the 1:1 conversation with a connected person. Idempotent —
  // returns the existing thread if there is one. Used by the "Message" button.
  openConversation: (userId) =>
    request("/api/conversations/", {
      method: "POST",
      body: { user_id: userId },
    }),

  // A single conversation (the other person, preview, unread) — for the thread
  // header, correct even on a cold page load.
  getConversation: (conversationId) =>
    request(`/api/conversations/${conversationId}/`),

  // Messages in a conversation, oldest-first, paginated.
  getMessages: (conversationId) =>
    request(`/api/conversations/${conversationId}/messages/`),

  // Send a message. Sender is the session user (never the body).
  sendMessage: (conversationId, text) =>
    request(`/api/conversations/${conversationId}/messages/`, {
      method: "POST",
      body: { text },
    }),

  // Soft-delete your own message (it becomes a "message deleted" placeholder).
  deleteMessage: (conversationId, messageId) =>
    request(`/api/conversations/${conversationId}/messages/${messageId}/`, {
      method: "DELETE",
    }),

  // Mark a conversation read up to now, clearing its unread count.
  markConversationRead: (conversationId) =>
    request(`/api/conversations/${conversationId}/read/`, { method: "POST" }),

  // Total unread messages across all conversations, for the nav badge.
  getUnreadMessageCount: () => request("/api/messages/unread-count/"),

  // Block / unblock a user — the strong, explicit cut (stops messaging and
  // (re)connecting, and hides your conversation from both of you).
  blockUser: (userId) =>
    request(`/api/users/${userId}/block/`, { method: "POST" }),

  unblockUser: (userId) =>
    request(`/api/users/${userId}/block/`, { method: "DELETE" }),

  // Create a multi-person chat. participantIds are your connections; a
  // non-connection is rejected. Optional title, and groupId to scope it to a
  // Phase 6 group (everyone must be a member of it).
  createGroupChat: ({ participantIds, title = "", groupId = null } = {}) =>
    request("/api/conversations/", {
      method: "POST",
      body: {
        participant_ids: participantIds,
        title,
        ...(groupId ? { group_id: groupId } : {}),
      },
    }),

  // Add more of your connections to an existing chat (any active member).
  addParticipants: (conversationId, userIds) =>
    request(`/api/conversations/${conversationId}/participants/`, {
      method: "POST",
      body: { user_ids: userIds },
    }),

  // Leave a chat (or decline an invite while pending).
  leaveConversation: (conversationId) =>
    request(`/api/conversations/${conversationId}/leave/`, { method: "POST" }),

  // The chats a disconnect/block would remove you from (for the warning modal).
  getDisconnectImpact: (userId) =>
    request(`/api/users/${userId}/disconnect-impact/`),

  // --- Groups (Phase 6) ----------------------------------------------------

  // The groups you're an active member of, ordered by name; each with a
  // member_count and your_role.
  getGroups: () => request("/api/groups/"),

  // Create a group. Multipart so it can carry an optional avatar file (name +
  // description ride along as fields). You become its first member, an admin.
  createGroup: ({ name, description = "", avatar } = {}) => {
    const form = new FormData();
    form.append("name", name);
    form.append("description", description);
    if (avatar) form.append("avatar", avatar);
    return request("/api/groups/", { method: "POST", body: form });
  },

  getGroup: (id) => request(`/api/groups/${id}/`),

  // Edit a group (admins only). Multipart, like the profile edit — pass
  // `removeAvatar: true` to clear an existing avatar.
  updateGroup: (id, { name, description, avatar, removeAvatar } = {}) => {
    const form = new FormData();
    if (name !== undefined) form.append("name", name);
    if (description !== undefined) form.append("description", description);
    if (avatar) form.append("avatar", avatar);
    if (removeAvatar) form.append("remove_avatar", "true");
    return request(`/api/groups/${id}/`, { method: "PATCH", body: form });
  },

  deleteGroup: (id) => request(`/api/groups/${id}/`, { method: "DELETE" }),

  // A group's timeline: its posts, newest-first, paginated. Members only.
  getGroupPosts: (id) => request(`/api/groups/${id}/posts/`),

  // A group's active members (each with their role).
  getGroupMembers: (id) => request(`/api/groups/${id}/members/`),

  // Invite one of your connections to a group (any member can invite; the
  // invitee accepts from their invites inbox).
  inviteToGroup: (id, userId) =>
    request(`/api/groups/${id}/members/`, {
      method: "POST",
      body: { user_id: userId },
    }),

  // Remove a member (admins), or — with your own id — leave the group.
  removeGroupMember: (id, userId) =>
    request(`/api/groups/${id}/members/${userId}/`, { method: "DELETE" }),

  // Promote/demote a member between "admin" and "member" (admins only).
  setGroupMemberRole: (id, userId, role) =>
    request(`/api/groups/${id}/members/${userId}/role/`, {
      method: "POST",
      body: { role },
    }),

  // Your pending group invitations + accept/reject.
  getGroupInvites: () => request("/api/group-invites/"),

  acceptGroupInvite: (id) =>
    request(`/api/group-invites/${id}/accept/`, { method: "POST" }),

  rejectGroupInvite: (id) =>
    request(`/api/group-invites/${id}/reject/`, { method: "POST" }),

  // --- Notifications / activity centre (Phase 8) ---------------------------

  // Your notifications, newest-first, paginated. Each carries a server-rendered
  // `text`, a deep-link `url`, and `seen`/`addressed` flags (the three states).
  getNotifications: () => request("/api/notifications/"),

  // Unread (not-yet-seen) count for the nav bell badge. Polled.
  getUnreadNotificationCount: () =>
    request("/api/notifications/unread-count/"),

  // Mark unread notifications seen (clears the badge, keeps the items). Called
  // when the activity centre opens. Omit `ids` to mark all unread seen.
  markNotificationsSeen: (ids) =>
    request("/api/notifications/seen/", {
      method: "POST",
      body: ids ? { ids } : {},
    }),

  // Mark one notification addressed (the dulled, dealt-with state) on
  // click-through. Addressing also implies seen.
  markNotificationAddressed: (id) =>
    request(`/api/notifications/${id}/addressed/`, { method: "POST" }),

  // Per-kind notification preferences as a { kind: bool } map over the mutable
  // kinds (reply/reaction). GET reads; PATCH accepts a partial map.
  getNotificationPreferences: () =>
    request("/api/notification-preferences/"),

  updateNotificationPreferences: (prefs) =>
    request("/api/notification-preferences/", {
      method: "PATCH",
      body: prefs,
    }),
};
