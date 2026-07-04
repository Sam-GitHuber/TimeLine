// Mock data for the Phase 1 wireframe.
//
// This file is deliberately the single, obvious place where the *shape* of a
// user and a post lives. There is no backend or database yet — everything here
// is fake and hard-coded. When we build the real API (Phase 3), these object
// shapes become the contract the backend must fulfil, so keep the field names
// meaningful.
//
// Conventions:
//   - `id` uniquely identifies a record (the DB will generate these later).
//   - `createdAt` is an ISO 8601 timestamp string. The feed sorts by it,
//     newest first — this is the whole point of TimeLine (reverse-chronological,
//     no ranking, ever).

export const users = [
  {
    id: 1,
    username: "sam",
    displayName: "Sam Jefford",
    bio: "Building TimeLine. Dad, cyclist, tea drinker.",
    joinedAt: "2026-01-04T09:00:00Z",
  },
  {
    id: 2,
    username: "priya",
    displayName: "Priya Patel",
    bio: "Photographer. Currently somewhere with better weather than you.",
    joinedAt: "2026-02-12T14:30:00Z",
  },
  {
    id: 3,
    username: "tom",
    displayName: "Tom Okafor",
    bio: "Amateur baker, professional procrastinator.",
    joinedAt: "2026-03-01T18:45:00Z",
  },
  {
    id: 4,
    username: "grandma_jean",
    displayName: "Jean Jefford",
    bio: "Sam's grandma. Here for the grandkids' photos.",
    joinedAt: "2026-03-20T11:15:00Z",
  },
];

// Posts reference their author by `authorId`. The real API will likely embed
// the author object, but keeping a reference here mirrors how the data is
// actually stored (a posts table with a foreign key to users) and keeps the
// single source of truth in `users`.
export const posts = [
  {
    id: 101,
    authorId: 2,
    createdAt: "2026-07-04T08:12:00Z",
    text: "Sunrise over the harbour this morning. Worth the 5am alarm. 🌅",
  },
  {
    id: 102,
    authorId: 3,
    createdAt: "2026-07-03T19:40:00Z",
    text: "Third loaf this week finally has a decent crumb. Sourdough is a cruel teacher.",
  },
  {
    id: 103,
    authorId: 1,
    createdAt: "2026-07-03T12:05:00Z",
    text: "Wireframe of TimeLine is coming together. Turns out the hard part isn't the code, it's resisting the urge to add an algorithm.",
  },
  {
    id: 104,
    authorId: 4,
    createdAt: "2026-07-02T16:20:00Z",
    text: "Lovely to see everyone at Sunday lunch. Don't forget your tupperware, Thomas.",
  },
  {
    id: 105,
    authorId: 2,
    createdAt: "2026-06-30T21:55:00Z",
    text: "Booked flights. If you need me next month I'll be unreachable and unbothered.",
  },
  {
    id: 106,
    authorId: 1,
    createdAt: "2026-06-28T10:30:00Z",
    text: "Reminder to self and anyone building software: boring, well-trodden solutions win.",
  },
  {
    id: 107,
    authorId: 3,
    createdAt: "2026-06-27T08:00:00Z",
    text: "Coffee first. Opinions later.",
  },
];

// The "logged-in" user for the wireframe. There is no real auth yet (that's
// Phase 2) — new posts from the compose box are attributed to this person.
export const currentUserId = 1;

// --- Lookup helpers -------------------------------------------------------

export function getUserById(id) {
  return users.find((u) => u.id === id);
}

export function getUserByUsername(username) {
  return users.find((u) => u.username === username);
}
