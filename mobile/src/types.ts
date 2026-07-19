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
