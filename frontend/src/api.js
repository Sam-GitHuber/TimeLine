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

/**
 * How often an open thread re-reads its conversation *detail* (Phase 9b M9c) —
 * the payload that carries each participant's read marker, and so the payload
 * the ticks are computed from.
 *
 * **Polled at all** because a marker fetched once when the thread opened is by
 * construction older than every message you send afterwards: a mount-time
 * snapshot can only ever say "sent" about the message you're actually watching,
 * and the second tick would appear only after leaving and coming back — the one
 * moment nobody is looking.
 *
 * **Slower than `MESSAGE_POLL_MS`** on purpose: the detail endpoint costs
 * several per-conversation queries where a message poll is one cheap page, and a
 * tick landing within ~12s reads as prompt where a *message* 12s late would not.
 * Mirrors the app's `CONVERSATION_DETAIL_POLL_MS`.
 */
export const CONVERSATION_DETAIL_POLL_MS = 12000;

// How long after sending a message you can still correct it (Phase 9b M9b) — a
// mirror of `MESSAGE_EDIT_WINDOW` in `backend/api/views.py`, and of the app's
// `MESSAGE_EDIT_WINDOW_MS`. The server stays authoritative; this only keeps the
// ⋯ menu from offering an Edit that would come back 403.
export const MESSAGE_EDIT_WINDOW_MS = 15 * 60 * 1000;

function getCookie(name) {
  const match = document.cookie.match(
    new RegExp("(?:^|; )" + name + "=([^;]*)")
  );
  return match ? decodeURIComponent(match[1]) : null;
}

class ApiError extends Error {
  // `fromServer` says the message is one the *server* wrote for a person (DRF's
  // `detail`), as opposed to one we synthesized because it sent nothing
  // showable. Only that first kind is fit to put in front of a user — see
  // `errors.js`. Hand-constructed ApiErrors default to true because the point of
  // writing one by hand is to give a person a sentence.
  //
  // `options` is passed through to `Error` so a network failure can keep the
  // original `TypeError` as its `cause` — unreadable to a user, but the only
  // thing that says *why* the connection died when debugging.
  constructor(message, status, data, fromServer = true, options = undefined) {
    super(message, options);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
    this.fromServer = fromServer;
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

  // A network-level failure — offline, DNS, the connection dropped mid-request —
  // rejects out of `fetch` itself as a bare `TypeError` carrying the *browser's*
  // words ("Failed to fetch" in Chrome, "Load failed" in Safari). Left alone it
  // propagates out of here untouched, and because it has a `message` it defeats
  // every `err?.message || "our sentence"` at a call site: the sentence written
  // for exactly this case becomes the one that never shows. So it's converted at
  // the source into the same shape every other rejection has.
  //
  // `status: 0` because no response ever arrived (there is no HTTP status to
  // report), and `fromServer: false` because the sentence below is ours, not the
  // server's — that flag is what keeps `serverMessage` honest, and it's the whole
  // reason a caller can still choose its own more specific copy.
  let response;
  try {
    response = await fetch(BASE_URL + path, {
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
  } catch (err) {
    throw new ApiError(
      "Couldn’t reach the server — check your connection and try again.",
      0,
      null,
      false,
      { cause: err }
    );
  }

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
    // A 500 rendered as a Django HTML page, or any body that isn't DRF's error
    // JSON, leaves nothing a person can read — so the synthesized stand-in is
    // flagged as *not* the server's own words.
    const authored = firstErrorMessage(data);
    throw new ApiError(
      authored || `Request failed (${response.status})`,
      response.status,
      data,
      Boolean(authored)
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

/**
 * The URL for a reaction action on whichever target was named (Phase 9b M9c) —
 * a post, a comment, or now a message.
 *
 * A helper rather than a ternary at each call site because there are three
 * targets, and because "none was passed" is genuinely reachable: the components
 * holding these ids carry them as optional props. Left alone that would build
 * `/api/comments/undefined/react/`, which 404s and surfaces as a mystery
 * "Couldn't react" — so it fails loudly here instead. Mirrors the app's
 * `reactionPath` in `mobile/src/api.ts`.
 */
function reactionPath(
  { postId = null, commentId = null, messageId = null },
  action
) {
  if (postId != null) return `/api/posts/${postId}/${action}/`;
  if (commentId != null) return `/api/comments/${commentId}/${action}/`;
  if (messageId != null) return `/api/messages/${messageId}/${action}/`;
  throw new Error("reactionPath needs a postId, commentId or messageId");
}

export const api = {
  ApiError,

  // Prime the csrftoken cookie. Call once on app load, before any mutation.
  ensureCsrf: () => request("/api/auth/csrf/"),

  // "Who am I" — resolves to the user, or throws (401) when logged out.
  getCurrentUser: () => request("/api/auth/user/"),

  // Turn read receipts on or off (Phase 9b M4). Its own call rather than a field
  // on updateProfile, which is multipart (it can carry an avatar) and would turn
  // a boolean into a string the server has to un-guess.
  //
  // The switch is symmetric and enforced server-side: with it off your read
  // marker is withheld from everyone else's conversation payload and theirs from
  // yours. The web doesn't draw ticks until M9, but the *setting* belongs on
  // both clients — a web-only member must be able to opt out of a disclosure
  // that's happening either way.
  setReadReceipts: (enabled) =>
    request("/api/auth/user/", {
      method: "PATCH",
      body: { send_read_receipts: enabled },
    }),

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

  // Verify an email address with the 6-digit code we emailed at sign-up. On
  // success the address is verified; the account still needs admin approval
  // before it can log in. Errors (wrong/expired code, unknown email) all come
  // back as the same generic message — we don't reveal which.
  verifyEmail: (email, code) =>
    request("/api/auth/verify-email/", {
      method: "POST",
      body: { email, code },
    }),

  // Ask for a fresh verification code. Always resolves the same way whatever the
  // address (enumeration-safe) — a code is only really sent to a real, not-yet-
  // verified account. Rate-limited server-side.
  resendVerification: (email) =>
    request("/api/auth/resend-verification/", {
      method: "POST",
      body: { email },
    }),

  // Begin a forgotten-password reset: email a 6-digit code. Enumeration-safe —
  // always resolves the same way whatever the address (a code is only really
  // sent to a real account). Rate-limited server-side.
  requestPasswordReset: (email) =>
    request("/api/auth/password-reset/", {
      method: "POST",
      body: { email },
    }),

  // Complete a reset with the emailed code + a new password. A wrong/expired code
  // and an unknown email come back as the same generic error (we don't reveal
  // which); password-strength/mismatch errors surface normally. On success you
  // can log in with the new password.
  confirmPasswordReset: (email, code, newPassword, confirmPassword) =>
    request("/api/auth/password-reset/confirm/", {
      method: "POST",
      body: {
        email,
        code,
        new_password1: newPassword,
        new_password2: confirmPassword,
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

  // Report a post, comment or message for the maintainer to review (Phase 7
  // takedown path; messages added in Phase 9b M0). Pass exactly one of
  // postId / commentId / messageId, plus an optional reason.
  //
  // Reporting a message is the *only* way its text reaches the maintainer — the
  // admin can't read a conversation any more (see reference/messaging.md), so the
  // report stores its own server-written snapshot of the text.
  reportContent: ({
    postId = null,
    commentId = null,
    messageId = null,
    reason = "",
  } = {}) =>
    request("/api/reports/", {
      method: "POST",
      body: {
        ...(postId ? { post: postId } : {}),
        ...(commentId ? { comment: commentId } : {}),
        ...(messageId ? { message: messageId } : {}),
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

  // Edit your own post's text (issue #62). Owner-only server-side (a non-owner
  // gets 403, a post you can't see 404s); the response carries a stamped
  // `edited_at` so the feed can show an "edited" marker. Text only in v1.
  updatePost: (id, text) =>
    request(`/api/posts/${id}/`, { method: "PATCH", body: { text } }),

  // Delete your own post (issue #62). Owner-only; cascades server-side to its
  // photos, comments, reactions and notifications. Returns 204.
  deletePost: (id) => request(`/api/posts/${id}/`, { method: "DELETE" }),

  // The visible comment tree for a post (already pruned server-side to people
  // you're connected with), and adding a comment/reply.
  getComments: (postId) => request(`/api/posts/${postId}/comments/`),

  addComment: (postId, { text, parent = null }) =>
    request(`/api/posts/${postId}/comments/`, {
      method: "POST",
      body: parent ? { text, parent } : { text },
    }),

  // Edit your own comment (issue #128). Owner-only server-side (a non-owner gets
  // 403, a comment you can't see 404s); the response is the whole comment node,
  // replies and all, with `edited_at` stamped so the thread can mark it.
  updateComment: (id, text) =>
    request(`/api/comments/${id}/`, { method: "PATCH", body: { text } }),

  // Delete your own comment (issue #128). Returns 204 either way — the server
  // removes the row outright when the comment has no replies, and leaves a
  // blanked tombstone when it does, so other people's replies survive. Which
  // happened is a property of the thread, so refetch it rather than guessing.
  deleteComment: (id) => request(`/api/comments/${id}/`, { method: "DELETE" }),

  // --- Reactions (Phase 7b; messages added in Phase 9b M9c) ----------------

  // Toggle your emoji reaction on a post, comment or message: adds it, or
  // removes it if you'd already used that emoji. Returns the target's fresh
  // reaction summary (`{ reactions: [{ emoji, count, reacted }] }`). Pass
  // exactly one of postId / commentId / messageId.
  toggleReaction: ({ emoji, ...target }) =>
    request(reactionPath(target, "react"), {
      method: "POST",
      body: { emoji },
    }),

  // Who reacted, grouped by emoji — for the "who reacted" popover. Pass exactly
  // one of postId / commentId / messageId.
  //
  // Post and comment reactors are pruned server-side to people you may see; a
  // *message*'s aren't, because a chat's active participants are already a
  // clique by construction, so everyone in a thread sees the same list
  // (docs/reference/reactions.md).
  getReactors: (target) => request(reactionPath(target, "reactions")),

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

  // Messages in a conversation, **newest-first**, paginated.
  //
  // `?order=desc` is what makes a thread openable in one request (Phase 9b M9b).
  // The endpoint's default is oldest-first, which puts the newest messages on
  // the *last* page — so "show me the bottom of this chat" used to mean walking
  // every page, which is exactly what the drawer did in an effect. Asking for
  // desc makes page one the screenful you open to and lets older messages page
  // in upward as you scroll back.
  getMessages: (conversationId) =>
    request(`/api/conversations/${conversationId}/messages/?order=desc`),

  /**
   * A handful of messages by id (Phase 9b M9d) — how a reply's collapsed quote
   * gets the words and the name it shows.
   *
   * 🔒 **This is the front door, not a way round it.** A reply's payload carries
   * `reply_to` as a bare `{ id }` on purpose: embedding the quoted body would
   * hand it to anyone who can see the *reply*, walking straight around the
   * server's interval clipping. `?ids=` is one more filter on the very queryset
   * the transcript reads, so an id the viewer was clipped out of comes back
   * **absent** — indistinguishable from one that never existed. A caller learns
   * nothing by asking, and the unresolved quote can honestly say so.
   *
   * Paginated like every message list, so a request for more ids than fit in a
   * page is answered short with a `next`; `quotes.js` is where that's handled.
   */
  getMessagesByIds: (conversationId, ids) =>
    request(
      `/api/conversations/${conversationId}/messages/?ids=${ids.join(",")}`
    ),

  /**
   * One reply strand — a root message and every reply hanging off it (Phase 9b
   * M9d). What the strand panel loads.
   *
   * It's the *same* endpoint as `getMessages` with a filter rather than a route
   * of its own, and that's deliberate on the server side: one queryset means a
   * strand can never show a message the transcript wouldn't. A viewer who was
   * clipped out of the root gets the replies they can see and no head, and the
   * panel renders that honestly instead of pretending the thread is broken.
   *
   * Being that same endpoint it paginates, oldest-first — this is page one, and
   * the caller follows `next`. Reading only this would cut a busy strand off at
   * its *oldest* twenty and hide the reply you just sent.
   */
  getThread: (conversationId, rootId) =>
    request(
      `/api/conversations/${conversationId}/messages/?thread_root=${rootId}`
    ),

  // Send a message. Sender is the session user (never the body).
  //
  // `replyToId` makes it a reply (Phase 9b M9d). The server validates it against
  // *your* visible messages, so an id from another thread or from inside a gap
  // in your membership is rejected exactly like one that doesn't exist. Replies
  // are one level deep: replying to a reply joins that strand rather than
  // nesting, which the server derives — the client never works out a root.
  //
  /**
   * `photo` attaches a picture (Phase 9b M9e) and switches the request to
   * multipart.
   *
   * 🔒 **Send only what came out of `prepareChatPhoto`.** The server does *not*
   * open the file — it can't, because this same path has to work when it's
   * handed ciphertext — so the resizing and EXIF stripping that helper does is
   * the *only* processing that happens to a chat photo. Handing the raw `File`
   * off the input straight to here would ship the photo's GPS coordinates to
   * everyone in the chat.
   *
   * `mentionIds` names people (Phase 9b M9f) — user ids, never the names in the
   * text. 🔒 It's the one argument here with any power behind it: a mention is
   * the only thing that beats a muted thread, so the server checks every id is
   * an *active* participant of a *group* chat and 400s anything else. Sent only
   * when there's something to send, so an ordinary message stays an ordinary
   * body. See `mentions.js`.
   */
  sendMessage: (
    conversationId,
    text,
    replyToId = null,
    photo = null,
    mentionIds = null
  ) => {
    const path = `/api/conversations/${conversationId}/messages/`;
    if (!photo) {
      return request(path, {
        method: "POST",
        body: {
          text,
          ...(replyToId ? { reply_to_id: replyToId } : {}),
          ...(mentionIds?.length ? { mention_ids: mentionIds } : {}),
        },
      });
    }
    const form = new FormData();
    // Blank is legal *with* a photo and only then — a photo with no caption is
    // an ordinary thing to send, an empty message is not. The server enforces
    // the same rule; this just doesn't get in its way.
    form.append("text", text);
    if (replyToId) form.append("reply_to_id", String(replyToId));
    // One part per id, not one part holding "1,2": DRF's `ListField` reads
    // repeated keys off multipart, and a comma-joined string arrives as a single
    // value it then refuses to parse as a list of integers.
    mentionIds?.forEach((userId) => form.append("mention_ids", String(userId)));
    // Parallel lists, one entry each. Plural because the server accepts a list
    // (capped at one for now — `MESSAGE_ATTACHMENTS_MAX`), so allowing several
    // photos per message later is a server constant rather than a wire change.
    form.append("attachments", photo.photo);
    form.append("attachment_thumbnails", photo.thumbnail);
    // Client-declared, and layout hints only: the bubble reserves space from
    // them so the transcript doesn't reflow as photos load. The server
    // bounds-checks them rather than trusting them, because it can't measure the
    // file itself.
    form.append("attachment_widths", String(photo.width));
    form.append("attachment_heights", String(photo.height));
    return request(path, { method: "POST", body: form });
  },

  /**
   * Every photo in this chat, newest first (Phase 9b M9e) — the media gallery on
   * the info panel.
   *
   * Another filter on the messages endpoint rather than a route of its own, for
   * the third time and the same reason as `thread_root` and `ids`: the gallery
   * must not be able to show a photo the transcript wouldn't, and the surest way
   * to guarantee that is for both to be the same interval-clipped queryset.
   */
  getConversationMedia: (conversationId) =>
    request(
      `/api/conversations/${conversationId}/messages/?media=1&order=desc`
    ),

  // Correct your own message (Phase 9b M9b). The reported problem that started
  // the whole messaging overhaul was that a typo was permanent.
  //
  // Sender-only, and only within the server's 15-minute window (403 after that:
  // a thread is a shared record, so you can fix "teh", not rewrite what someone
  // read and replied to yesterday). A deleted message can't be edited (400).
  //
  // Deliberately does **not** bump the conversation's activity time — fixing a
  // typo shouldn't jump the thread to the top of everyone's list — so the
  // conversation list needs its preview refreshed, never reordering.
  editMessage: (conversationId, messageId, text) =>
    request(`/api/conversations/${conversationId}/messages/${messageId}/`, {
      method: "PATCH",
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

  /**
   * Put the badge back on a thread you've read (Phase 9b M9e) — for the people
   * who use it as a to-do list.
   *
   * The server moves your read marker to just behind the newest message you
   * didn't send, rather than dropping it: with no marker the *whole history*
   * counts as unread, so a chat you'd read to the end would come back wearing
   * "99+". It comes back as one, which is what "waiting for you" means here.
   *
   * It aims at the newest **visible, incoming, undeleted** message *anywhere* in
   * the thread, not at the last one — so a chat you replied to marks unread
   * fine, landing past your own trailing messages. 400 only when there's
   * genuinely nothing to aim at: an empty thread, or one where every visible
   * message is yours or a tombstone.
   *
   * 🔒 **It also retracts your read receipt** for that message, since ticks and
   * unread counts are read off the same marker — see messaging.md.
   */
  markConversationUnread: (conversationId) =>
    request(`/api/conversations/${conversationId}/read/`, { method: "DELETE" }),

  /**
   * Rename a group chat (Phase 9b M9e). Until M6 a title could only be set when
   * the chat was created, so "Weekend plans" outlived the weekend.
   *
   * Any *active* member may — chats have no admin role, and inventing one for a
   * text field would be the wrong place to start. Group chats only (400 on a
   * 1:1, whose name is the other person). Blank clears it, and both clients then
   * fall back to the members' names, which beats a stale title.
   *
   * It deliberately doesn't bump the thread's activity time, so renaming doesn't
   * jump it to the top of everyone's list — same rule as an edit.
   */
  renameConversation: (conversationId, title) =>
    request(`/api/conversations/${conversationId}/`, {
      method: "PATCH",
      body: { title },
    }),

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

  // Mute/unmute this thread's push notifications for you (issue #118). The web
  // app itself has no push, so this control exists here to manage what your
  // *phone* does — muting from the browser you happen to have open is the point.
  setConversationMuted: (conversationId, muted) =>
    request(`/api/conversations/${conversationId}/mute/`, {
      method: muted ? "POST" : "DELETE",
    }),

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

  // --- Group events & planning calendar (Phase 8b) -------------------------

  // A group's events you can see (members only; each pruned to those organised
  // by someone you're connected with). `window` is "upcoming" (default), "past",
  // or "all". Returns a plain array (not paginated) — bounded by the window.
  getGroupEvents: (groupId, window = "upcoming") =>
    request(`/api/groups/${groupId}/events/?window=${window}`),

  // Plan an event in a group (any active member). Body is the organiser-authored
  // fields; the date/time/location are set later via finalise. Returns the new
  // event (in `planning`, with the creator as organiser).
  createEvent: (groupId, { title, description = "", timezone } = {}) =>
    request(`/api/groups/${groupId}/events/`, {
      method: "POST",
      body: {
        title,
        description,
        ...(timezone ? { timezone } : {}),
      },
    }),

  // A single event: dimensions + their states, your RSVP/votes, poll tallies
  // (counts complete, names connection-gated), and can_manage/can_moderate.
  // 404 if you're not connected to the organiser.
  getEvent: (eventId) => request(`/api/events/${eventId}/`),

  // Edit an event's non-scheduling fields (organiser only): title, description,
  // location link/note, timezone, end time.
  updateEvent: (eventId, fields) =>
    request(`/api/events/${eventId}/`, { method: "PATCH", body: fields }),

  // Soft-cancel an event (organiser or a group admin) — a tombstone that
  // notifies going/maybe RSVPs, not a delete.
  cancelEvent: (eventId) =>
    request(`/api/events/${eventId}/cancel/`, { method: "POST" }),

  // Hard-delete an event (organiser or a group admin). Cascades. Returns 204.
  deleteEvent: (eventId) =>
    request(`/api/events/${eventId}/`, { method: "DELETE" }),

  // Upsert your RSVP (any member who can see the event). One RSVP per person.
  rsvpEvent: (eventId, { response, guests = 0, note = "" }) =>
    request(`/api/events/${eventId}/rsvp/`, {
      method: "PUT",
      body: { response, guests, note },
    }),

  // The event's RSVPs: complete counts + connection-gated named lists.
  getEventRsvps: (eventId) => request(`/api/events/${eventId}/rsvps/`),

  // Open a poll on a dimension (organiser). `options` is an array of
  // { label?, date_value?/time_value?/text_value? } depending on the dimension.
  createPoll: (eventId, { dimension, question, allowMultiple, closesAt, options }) =>
    request(`/api/events/${eventId}/polls/`, {
      method: "POST",
      body: {
        dimension,
        ...(question !== undefined ? { question } : {}),
        ...(allowMultiple !== undefined ? { allow_multiple: allowMultiple } : {}),
        ...(closesAt ? { closes_at: closesAt } : {}),
        options,
      },
    }),

  // A poll + its options + results (counts complete, voter names gated).
  getPoll: (pollId) => request(`/api/polls/${pollId}/`),

  // Fix a poll's mistakes (organiser). Any of `question`, `allowMultiple`
  // (pick-one vs pick-any), and `options` — each option entry `{ id, ...value }`
  // carries the typed field for the poll's dimension (`date_value` /
  // `time_value` / `text_value`); the label re-derives server-side. Refused
  // (409) once the poll has any votes.
  editPoll: (pollId, { question, allowMultiple, options }) =>
    request(`/api/polls/${pollId}/`, {
      method: "PATCH",
      body: {
        question,
        ...(allowMultiple !== undefined ? { allow_multiple: allowMultiple } : {}),
        options,
      },
    }),

  // Cast/replace your votes — `optionIds` is your full selection (an empty list
  // clears your vote). Only while the poll is open.
  votePoll: (pollId, optionIds) =>
    request(`/api/polls/${pollId}/vote/`, {
      method: "PUT",
      body: { option_ids: optionIds },
    }),

  // Close a poll without deciding (organiser) — freezes the tally.
  closePoll: (pollId) =>
    request(`/api/polls/${pollId}/close/`, { method: "POST" }),

  // Re-open a closed poll (organiser) — voting resumes on the tally.
  reopenPoll: (pollId) =>
    request(`/api/polls/${pollId}/reopen/`, { method: "POST" }),

  // Remove a poll (organiser).
  deletePoll: (pollId) =>
    request(`/api/polls/${pollId}/`, { method: "DELETE" }),

  // The organiser's *decision* on a dimension (advisory poll → set value). For a
  // built-in, `value` writes the field (need not be a poll option); for custom,
  // `optionId` pins a winning option. Recomputes status, notifies.
  finaliseEvent: (eventId, { dimension, value, optionId, closePoll = true }) =>
    request(`/api/events/${eventId}/finalise/`, {
      method: "POST",
      body: {
        dimension,
        ...(value !== undefined ? { value } : {}),
        ...(optionId !== undefined ? { option_id: optionId } : {}),
        close_poll: closePoll,
      },
    }),

  // One group's dated events in a window, for the month grid.
  getGroupCalendar: (groupId, { from, to } = {}) => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    return request(`/api/groups/${groupId}/calendar/${qs ? `?${qs}` : ""}`);
  },

  // The personal calendar: a time-merge of the dated events you can see across
  // every group you're a member of. Each event carries its group label.
  getPersonalCalendar: ({ from, to } = {}) => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    return request(`/api/calendar/${qs ? `?${qs}` : ""}`);
  },
};
