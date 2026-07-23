/**
 * Types for the JSON the Django API returns.
 *
 * These are hand-written to match the DRF serializers — nothing generates or
 * verifies them, so when a serializer changes, change the type here too. Field
 * names are snake_case because that's what the API sends; we deliberately don't
 * camelCase-convert on the way in, so a field name in this app always matches
 * the one in `backend/` and in the reference docs.
 */

/** `GET /api/auth/user/` — `accounts.serializers.UserDetailsSerializer`. */
export type User = {
  pk: number;
  email: string;
  first_name: string;
  last_name: string;
  /** Real first + last name. There is no username in this product, ever. */
  display_name: string;
  bio: string;
  avatar_url: string | null;
  avatar_thumb: string | null;
  /** Read-only; gates maintainer-only UI. Not a security control. */
  is_staff: boolean;
};

/**
 * `GET /api/users/<id>/` — `api.serializers.UserListSerializer`.
 *
 * The public view of *someone else's* profile, distinct from the `User` above:
 * no email, no first/last name split, no `pk` (it's `id` here, matching every
 * other embedded user in the API). It carries the viewer-relative fields the
 * profile header needs — `connection_status` and `is_blocked` — which the
 * self-only `User` type has no reason to.
 *
 * `connection_status` is *your* relationship to this person:
 *   - `"none"`      — no link (Connect)
 *   - `"requested"` — you asked, awaiting them
 *   - `"incoming"`  — they asked, awaiting you
 *   - `"connected"` — mutual; you can see each other's posts
 *
 * The Connect / Message / Block actions this status drives are Milestone E
 * (connections/block); C4 only reads it to decide whether posts are visible.
 */
export type ProfileUser = {
  id: number;
  display_name: string;
  bio: string;
  avatar_thumb: string | null;
  connection_status: 'none' | 'requested' | 'incoming' | 'connected';
  is_blocked: boolean;
};

/**
 * A row in the People hub's lists — `api.serializers.UserListSerializer`, the
 * same serializer behind `getUser`. It's structurally a `ProfileUser`: the
 * `/api/users/` list endpoint annotates `connection_status` per row and defaults
 * `is_blocked` to `false` (block state is only surfaced on the profile detail),
 * so one type serves both. Aliased rather than duplicated so a serializer change
 * lands in one place.
 */
export type PersonSummary = ProfileUser;

/**
 * `GET /api/connection-requests/` — `ConnectionRequestSerializer`.
 *
 * One incoming request in *your* inbox: someone has asked to connect with you
 * and is waiting on your approval. `id` is the underlying `Connection` row's id
 * — the handle you pass to approve/reject, **not** the requester's user id.
 */
export type ConnectionRequest = {
  id: number;
  requester: Author;
  created_at: string;
};

/**
 * `GET /api/users/<id>/disconnect-impact/` — the shared group chats a disconnect
 * (or block) would drop you out of, so the warning modal can name them before
 * you confirm. Empty when severing this connection breaks no chat.
 */
export type DisconnectImpact = {
  chats: { id: number; title: string; kind: string }[];
};

/** `POST /api/auth/mobile/login/` — see `accounts.views.MobileLoginView`. */
export type LoginResponse = {
  access: string;
  refresh: string;
  user: User;
};

/** `POST /api/auth/mobile/refresh/` — rotation means a *new* refresh comes back. */
export type RefreshResponse = {
  access: string;
  refresh: string;
};

/**
 * DRF's `PageNumberPagination` envelope (`PAGE_SIZE = 20`, applied app-wide).
 *
 * **Every list endpoint is paginated** — people, requests, groups, all of them.
 * Read `count` for totals (never `results.length`, which is just this page) and
 * follow `next` to page through. See feed-and-posts.md.
 */
export type Paginated<T> = {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
};

/** The minimal user slice embedded in a post — `AuthorSerializer`. No email. */
export type Author = {
  id: number;
  display_name: string;
  avatar_thumb: string | null;
};

/** One photo on a post. Dimensions let us reserve layout space before it loads. */
export type PostImage = {
  id: number;
  image: string;
  thumbnail: string;
  width: number;
  height: number;
};

/**
 * An aggregated emoji reaction, already pruned to what this viewer may see.
 * `reacted` is whether *you* are one of the counted reactors.
 */
export type Reaction = {
  emoji: string;
  count: number;
  reacted: boolean;
};

/**
 * A node in a post's comment tree — `CommentSerializer`.
 *
 * **`replies` is already pruned server-side.** The tree you receive contains
 * only comments from people you're connected with; a not-connected author's
 * comment *and its whole subtree* are dropped before serialising (see
 * connections.md). So there is no hidden content here to filter — render what
 * arrives. Two viewers legitimately see different trees on the same post.
 */
export type Comment = {
  id: number;
  author: Author;
  /** `null` for a top-level comment; otherwise the comment this replies to. */
  parent: number | null;
  text: string;
  created_at: string;
  replies: Comment[];
  reactions: Reaction[];
};

/**
 * What the toggle endpoints return: the target's freshly aggregated, viewer-
 * pruned reaction summary, so the client can update in place without refetching.
 */
export type ReactionSummary = {
  reactions: Reaction[];
};

/**
 * One row of "who reacted", grouped by emoji and pruned to people you may see —
 * a reactor you aren't connected with never appears. Ordered by count desc.
 */
export type ReactorGroup = {
  emoji: string;
  count: number;
  users: Author[];
};

/**
 * One member of a chat — `ParticipantSerializer`. `status` is *their* membership
 * state: `active` members can read and send; a `pending` invitee is in the
 * waiting room (invited but not yet connected to the whole active clique) and
 * sees only the locked panel until they're promoted. See messaging.md.
 */
export type Participant = {
  id: number;
  display_name: string;
  avatar_thumb: string | null;
  status: 'active' | 'pending';
};

/**
 * The last-message preview on a conversation row — the flattened slice
 * `get_last_message` attaches (deliberately *not* a full `Message`: it carries
 * only `sender_id`, not the embedded sender object, since the row just needs
 * "You: …" vs the text). `text` is blank when `is_deleted`; the row renders a
 * "Message deleted" placeholder in its place.
 */
export type LastMessage = {
  text: string;
  is_deleted: boolean;
  sender_id: number;
  created_at: string;
};

/**
 * A conversation — `ConversationSerializer`. The one type serves both the list
 * row and the single-thread detail, exactly as the serializer does; which fields
 * are populated differs by endpoint (see the per-field notes):
 *
 *   - `other` — the person you're talking to, on a `direct` thread only (`null`
 *     for a group). Resolved per-viewer server-side.
 *   - `participants` — every member + their `status`; drives the group header's
 *     avatar-stack and the pending panel's "connect with X" list.
 *   - `my_status` — *your* membership: a `pending` viewer gets the locked panel
 *     (and `must_connect_with`) instead of message access.
 *   - `last_message` / `unread_count` — attached per-viewer on the **list** only.
 *   - `can_send` — whether you may still post; set only on the **detail** view
 *     (`null` in the list). History stays readable even when it's `false`.
 */
export type Conversation = {
  id: number;
  kind: 'direct' | 'group';
  title: string;
  /** The group this chat belongs to, when it's a group-scoped chat; else null. */
  group: { id: number; name: string } | null;
  other: Author | null;
  participants: Participant[];
  my_status: 'active' | 'pending' | null;
  /** People a pending viewer must connect with before they're let in. */
  must_connect_with: Author[];
  last_message: LastMessage | null;
  unread_count: number;
  can_send: boolean | null;
  updated_at: string;
};

/**
 * One message in a thread — `MessageSerializer`. `sender` is the embedded author
 * slice, so the thread can align/attribute each bubble. A soft-deleted message
 * reports `is_deleted: true` with blank `text`; the client renders a "message
 * deleted" tombstone in its place, keeping the thread's order intact.
 */
export type Message = {
  id: number;
  sender: Author;
  text: string;
  is_deleted: boolean;
  created_at: string;
};

/**
 * A group — `GroupSerializer`. Private, invite-only shared timeline (see
 * groups.md). `member_count` and `your_role` are per-viewer, attached by the
 * view: `your_role` (`admin`/`member`) drives whether the admin controls show,
 * and is `null` on a group you're only *invited* to (not yet a member).
 */
export type Group = {
  id: number;
  name: string;
  description: string;
  avatar_url: string | null;
  avatar_thumb: string | null;
  member_count: number;
  your_role: 'admin' | 'member' | null;
  created_at: string;
};

/** One active member of a group — `GroupMemberSerializer`. */
export type GroupMember = {
  user: Author;
  role: 'admin' | 'member';
};

/**
 * A pending invite in your group-invites inbox — `GroupInviteSerializer`. `id`
 * is the membership row's id (the handle to accept/reject), **not** the group id.
 */
export type GroupInvite = {
  id: number;
  group: { id: number; name: string; avatar_thumb: string | null };
  invited_by: Author;
  created_at: string;
};

/**
 * One built-in dimension's state on an event — `_dimension_states`. Each of
 * `date` / `time` / `location` is `set` (its field is populated), `polling` (an
 * open poll targets it), or `unset`. `poll` is that open poll's id (surfaced
 * even on a `set` dimension, so a re-poll on a decided value still shows a live
 * tally on the chip); `null` otherwise. See events.md.
 */
export type DimensionState = {
  state: 'unset' | 'polling' | 'set';
  poll: number | null;
};

/**
 * One option's tally in a poll — `build_poll_results`. **The count is complete**
 * across the whole audience; **`voters` is connection-gated** (only you + your
 * connections — everyone else folds into `count` as an anonymous +1). One typed
 * value column is populated per the poll's dimension. `you_voted` flags your own
 * pick. See decision 2 in events.md.
 */
export type PollResultOption = {
  id: number;
  label: string;
  date_value: string | null;
  time_value: string | null;
  text_value: string | null;
  order: number;
  count: number;
  voters: Author[];
  you_voted: boolean;
};

/**
 * One option in a poll create/edit payload (E3c-b). Typed to the poll's
 * dimension — exactly one of the value fields is sent. An `id` marks an existing
 * option to rewrite on edit; its absence means a new option. See events.md.
 */
export type PollOptionPayload = {
  id?: number;
  date_value?: string;
  time_value?: string;
  text_value?: string;
};

/**
 * An advisory poll on one event dimension — `serialize_poll`. Polls never
 * auto-decide (decision 3): the tally *informs*, the organiser *decides* via
 * finalise. `allow_multiple` is pick-any vs pick-one. `your_votes` is your
 * current selection (drives the vote control's pressed state). `vote_count` is
 * the complete total — the client gates the (E3c) edit affordance on it being 0,
 * matching the server's 409. `decided_option` is the pinned option for a
 * finalised *custom* poll (built-ins write the event's fields instead).
 */
export type Poll = {
  id: number;
  event: number;
  dimension: 'date' | 'time' | 'location' | 'custom';
  question: string;
  allow_multiple: boolean;
  status: 'open' | 'closed';
  closes_at: string | null;
  created_at: string;
  options: PollResultOption[];
  vote_count: number;
  your_votes: number[];
  decided_option: number | null;
};

/**
 * An event's RSVP tallies — `build_rsvp_summary`. **Counts are complete**;
 * **named lists are connection-gated** and present only on the *detail* payload
 * (`named=True`) — the calendar/list summaries omit them. `guests` is the summed
 * "+N" headcount of the *going* responses. `your_response` is your own RSVP (or
 * null). See decision 2 in events.md.
 */
export type RsvpSummary = {
  counts: { going: number; maybe: number; declined: number; guests: number };
  your_response: {
    response: 'going' | 'maybe' | 'declined';
    guests: number;
    note: string;
  } | null;
  going_list?: Author[];
  maybe_list?: Author[];
  declined_list?: Author[];
};

/**
 * A group event — `serialize_event`. Connection-gated to its **organiser** (a
 * 404 if you're not connected, exactly like their posts): whoever you see an
 * event iff you're a member of the group *and* connected to whoever organised it.
 * `status` is derived from the dimensions on write; `is_past`/`starts_at` are
 * computed. The scheduling fields (`event_date`/`start_time`/`location_name`)
 * are written only through finalise (E3c), never a plain edit. See events.md.
 *
 * The named RSVP lists and richer poll detail ride the full detail payload
 * (`getEvent`); the list/calendar payloads carry the same shape with the named
 * lists omitted, so one type serves both.
 */
export type Event = {
  id: number;
  group: { id: number; name: string };
  organiser: Author;
  title: string;
  description: string;
  /** `YYYY-MM-DD`, null until a date is set — the calendar key. */
  event_date: string | null;
  /** `HH:MM:SS`, null when the event is all-day (date only). */
  start_time: string | null;
  end_time: string | null;
  /** One IANA name per event (a documented simplification). */
  timezone: string;
  location_name: string;
  /** An organiser-pasted link — never geocoded, never an embedded map. */
  location_url: string;
  location_note: string;
  status: 'planning' | 'scheduled' | 'cancelled';
  is_past: boolean;
  starts_at: string | null;
  dimensions: { date: DimensionState; time: DimensionState; location: DimensionState };
  rsvp: RsvpSummary;
  /** You are the organiser (the E3c control surface unlocks on this). */
  can_manage: boolean;
  /** You are the organiser or a group admin (cancel/delete). */
  can_moderate: boolean;
  created_at: string;
  updated_at: string;
  polls: Poll[];
};

/** `GET /api/feed/` and `GET /api/posts/<id>/` — `PostSerializer`. */
export type Post = {
  id: number;
  author: Author;
  text: string;
  images: PostImage[];
  /** `null` for a personal post; `{id, name}` when it belongs to a group. */
  group: { id: number; name: string } | null;
  reactions: Reaction[];
  comment_count: number;
  /** Comments added since you last opened this thread. */
  new_comment_count: number;
  created_at: string;
  /** `null` until the first edit — that's how "never edited" is told apart. */
  edited_at: string | null;
};
