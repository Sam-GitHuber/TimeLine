# Feed, posts, photos & profiles

The core of the product: posting text + photos, the reverse-chronological feed,
profile pages, and the image-handling pipeline. Visibility (who can see whose
posts) is owned by [connections](connections.md); group posts are covered in
[groups](groups.md). This doc is the current-state reference.

Code: `Post` / `PostImage` models + feed/profile views in `backend/api/`,
image pipeline in `backend/api/imaging.py`, profile edit rides dj-rest-auth
(`backend/accounts/serializers.py`). Frontend: `PostCard`, `ComposeBox`,
`Avatar`, the feed page, and `ProfileEditForm` (inline on the profile page).

## The feed — reverse-chronological, always

No ranking, no "suggested" posts, no algorithm — ever. This is a non-negotiable
product principle, enforced server-side so it can't drift:

- `GET /api/feed/` returns your own posts plus posts from everyone you're
  connected with (see [connections](connections.md)), ordered `created_at`
  descending, paginated.
- **Ordering is enforced in the DB**, not the client: `Post.Meta.ordering =
  ["-created_at", "-id"]`. The `-id` tiebreaker matters — posts sharing a
  timestamp have no stable order otherwise, which made pagination duplicate/skip
  rows on Postgres. `created_at` is indexed.
- The home feed **excludes group posts by default** (`group__isnull=True`) so its
  meaning stays "the people I'm connected with". An opt-in `?include_groups=1`
  toggle merges group posts in strictly chronologically — a pure time-merge, no
  ranking. See [groups](groups.md).

### Pagination

DRF `PageNumberPagination`, `PAGE_SIZE = 20`, applied app-wide. **Consequence to
remember:** turning this on paginates *every* list endpoint (people, requests,
etc.), so every list consumer must page through results, not read only
`data.results`. The frontend does this via a shared `useInfiniteList(queryKey,
firstPageFn)` hook + `<LoadMoreButton>` that follows the response's `next` URL
(`api.getPage`, which parses the URL and keeps only path+query so it works behind
a proxy / on a separate API domain). Nav badges read the paginator's `count`, not
`results.length`.

`useInfiniteList` also **dedupes the flattened rows by id**, and it does so for
every list on the site, not just the one that prompted it (#134). Page-*number*
paging shifts its window whenever the underlying set changes mid-scroll —
someone posts, someone connects — so page 2 re-sends a row page 1 already
showed, and two rows end up sharing a React key. The repeat is dropped rather
than de-duplicated by position, which leaves the server's order untouched: on
the feed that order is the product's one non-negotiable guarantee. The app does
the same, in `dedupeById` (`mobile/src/lists.ts`). It is a second line of
defence, not the fix — the `-id` tiebreaker above is what stops the window
shifting for *equal timestamps*; this covers the set genuinely changing under
you. A third argument on the hook passes query options straight through
(`enabled`, and the like); the paging keys are spread last so a caller can't
reach in and change how the list pages.

A few lists are wanted *whole* rather than a page at a time, because something
real bounds them — your connections (the two message/invite pickers) and the
replies to one message ([messaging](messaging.md)). They use
**`useFetchAllPages(query)`** — one on each client, `frontend/src/hooks.js` and
`mobile/src/lists.ts`, over the same three lists — which asks for the next page
as soon as the one before it lands, and it is one shared hook per client rather
than an effect per caller because of the way that effect fails:

⚠️ **A page that fails must stop the walk, not restart it** (#214 for the web,
#248 for the app, which had the same effect copy-pasted into all three screens).
The obvious
guard — `if (hasNextPage && !isFetchingNextPage) fetchNextPage()` — re-arms
itself on a failure. The server never said there was no page 2, so `hasNextPage`
stays true; `isFetchingNextPage` going false again *is* the condition the effect
waits for. So a 500 or a dropped connection turned into one request per render
commit, for as long as the view stayed open, with the client's own retries
stacked on each — three on the web, which takes TanStack's default, and one on
the app, where `_layout.tsx` bounds it deliberately because "phones drop
connections constantly" — against an endpoint that by definition had just
failed, from a
phone whose connection had just dropped. Adding `!isError` stops it: what loaded
stays on screen as a partial list, and recovery is automatic, since any later
fetch that succeeds (a poll, a refocus) clears the flag and the remaining pages
resume.

⚠️ **The price of not looping is that a caller has to render `isError`**, since a
list that stopped short is indistinguishable from one that ended. On a picker
that matters more than it sounds: a connection missing from a truncated list
reads as *"you aren't connected to that person"*, which is a wrong answer rather
than an absent one, and the empty state ("You can only invite people you're
connected with") is the same lie in stronger terms — so it's gated on `isError`
too. All six call sites render it.

⚠️ **And it has to be rendered where a *partial* list can show it.** The case
this obligation exists for is the list that isn't empty — page one landed, page
two didn't — so on the app an error branch inside `ListEmptyComponent` doesn't
discharge it, and both pickers put the line in a `ListHeaderComponent` above the
rows instead. The strand puts its equivalent in the footer, because its pages run
oldest-first and so the replies it's missing are the newest ones.

This is only a hazard for the *effect-driven* walk. A list that pages from a
scroll handler, an `onEndReached`, or a `<LoadMoreButton>` needs no such guard: a
failed page there produces no scroll and no click, so nothing re-fires it. That
covers every other paged list on both clients — the feed, activity, people,
groups, profiles, and the message transcript's `loadOlder`.

## Posts

- **`Post`** — `author`, `text`, `created_at`, nullable `group` FK (null = a
  personal post; see [groups](groups.md)). Lives in the `api` app.
- **Author is never trusted from the client** — `POST /api/posts/` ignores any
  `author` in the body and sets it from `request.user`.
- **`visible_posts(user, author=None)`** is the single "who can I see" helper used
  by both the feed and profile views so they can't drift; it filters
  `author__is_active` (a deactivated/banned member's posts drop out everywhere).
- Posts are created via multipart `POST /api/posts/` (text and/or photos).
- **TanStack Query** drives the frontend; mutations invalidate `["feed"]` /
  `["users"]` / `["user", id]` so posting or connecting refreshes the affected
  views immediately.
- **A new post refreshes two lists, and which two is a rule the compose box
  owns** (`ComposeBox.jsx` / `ComposeBox.tsx`, both `onSuccess`). Always
  `['feed']` — a group post surfaces on the home feed via the *include groups*
  toggle — and then the one list it landed in: `['groupPosts', groupId]` for a
  group post, `['userPosts']` for a personal one. Those two are genuinely
  either/or, because `visible_posts` filters `group__isnull=True` for a profile,
  so a group post is never on your own timeline.

  Mobile used to take the key from the caller (an `invalidateKey` prop), and
  each screen naturally passed the one list it was itself showing — so a group
  post refreshed the group and nothing else (#275). The symptom is #273's
  exactly: a tab navigator keeps the Home tab mounted, so its query has a live
  observer, never remounts, and `staleTime: 0` doesn't rescue it; the post is
  missing from the feed until a pull-to-refresh or an app foreground. **Deciding
  the key at the call site is the bug** — the rule belongs where the write is.
  A regression test for this must mount observers on the other surfaces, not
  seed cache entries (same reasoning as the badge tests below).

  **It stays in the compose box rather than moving to `postCache`**, which is
  the natural place to look given `invalidatePostComments` lives there. That
  helper earns its place by *deriving* its keys from the `POST_LIST_KEYS` set it
  shares with `markPostCommentsSeen`, so the two can't drift — it hits every
  post list, unconditionally. A new post is the other shape: exactly two lists,
  and which two depends on whether it went to a group. There's nothing to
  derive, so extracting it would move two lines without buying the guarantee.

### Permalink — a single post by id

- **`GET /api/posts/<id>/`** (`PostDetailView`) returns one post, gated by the
  same `can_view_post` wall as the feed (a post you can't see 404s — existence
  isn't leaked). It backs the **`/p/:id` permalink page** (`PostPage`), which
  renders the post with its comment thread opened.

### Editing & deleting your own posts

The **`⋯` overflow menu** on a post's header (`PostMenu.jsx` / mobile
`PostMenu.tsx`, rendered by `PostCard`) is where per-post actions live. **Both
clients offer the same three actions**, keyed off the same owner check
`ReportButton` uses (`user.pk === author.id`):

- **Your own post:** **Edit** (opens straight into the editor) and **Delete**
  (confirms first, since a post can carry comments/reactions/photos). Edit sits
  **above** Delete and is styled plainly, so the finger heading for the safe
  action never passes over the destructive one.
- **Someone else's post:** **Report** — the report control **moved off the footer
  row into this menu**. Comments followed in #128, so a ⋯ with this same
  owner/non-owner split is now the one shape on both surfaces and both clients;
  the web's lives in `OverflowMenu.jsx`, shared by the two.

**The editor's shape deliberately differs by client** (issue #146 — the app had
no edit path at all until then, so a typo made on the phone could only be fixed
from the web):

- **Web:** the card flips its text into an inline editor (`PostEditor` in
  `PostCard.jsx`), no separate page.
- **Mobile:** a modal sheet (`PostEditModal.tsx`), *not* an inline editor, and
  the list is the reason rather than taste. `PostCard` renders inside a
  virtualised `FlatList`: an inline `TextInput` would open under the keyboard
  with nothing to scroll, and a row scrolled out of the window unmounts — taking
  a half-typed edit with it. The sheet follows `ReportModal` (a
  `KeyboardAvoider` inside a `<Modal>` whose `onRequestClose` handles Android
  back), and it confirms before discarding an edit in progress, because a stray
  tap on the backdrop otherwise costs you your typing.

Both clients disable Save when a **text-only** post is emptied (mirroring the
server's rule below, so the button never 400s), allow a photo post to keep no
text, and invalidate `["feed"]`, `["userPosts"]`, `["groupPosts"]` and
`["post", id]` on success so the new text and its marker appear everywhere the
post shows. **The app additionally treats an unchanged Save as a plain close** —
the server already refuses to stamp `edited_at` on a no-op, so nothing visible
differs, but on a phone it saves a round-trip and four refetches (the feed among
them). That's the rule the message editor already follows; the web still sends
the no-op PATCH.

Both edit and delete share the permalink route — `PostDetailView` is a
`RetrieveUpdateDestroyAPIView`:

- **`PATCH /api/posts/<id>/`** — **owner-only**, updates **text only** (v1 scope:
  adding/removing photos is deliberately out). It stamps `edited_at` and rejects
  emptying a text-only post (a post must still have text or a photo, mirroring
  create). `PUT` is disallowed (405) — text is the only writable field.
- **`DELETE /api/posts/<id>/`** — **owner-only**, 204 on success. The model's
  CASCADE relations take the post's images, comments (and replies), reactions,
  reports and notifications with it. The image **files** are swept off storage
  too (on commit, so a rolled-back delete can't strand a live row without its
  file) — as with group deletion. See `docs/reference/accounts.md`, "Account
  deletion", for the shared helpers any new delete path must use.
- **Permission shape mirrors `GroupDetailView`:** a post you can't see is a
  **404** (existence stays hidden); a post you can see but don't own is a **403**.
  The **author path bypasses the visibility gate** — you can always edit/delete
  your own post, including a group post you've since left the group of (your
  content stays yours to remove). A no-op edit (text unchanged) is a 200 that
  does **not** stamp `edited_at`, so the marker only ever means a real change.

**The edited marker is the transparency floor.** `Post.edited_at` is **null until
the first edit** — that's how "created but never edited" is told apart (no
`updated_at`/timestamp-comparison guesswork). The serializer exposes it read-only;
`PostCard` shows a quiet **"· edited"** next to the author line **only** when it's
set — on the web with the exact edit time on hover/focus (`title`/`aria-label`,
the same pattern `created_at` uses); the app shows the marker alone, there being
no hover on a phone. Silently altering content others have already read is
a trust problem on an app holding real friends'/family's conversations, so the
marker isn't optional.

**No edit window and no version history** (v1) — this is a private friends/family
app, not a public record; the "edited + when" marker is the agreed transparency
floor — and it applies to a phone edit exactly as it does to a web one, which is
why the app's edit sheet says so before you save rather than only after.
- **Why fetch by id rather than reuse a feed row:** notifications
  ([notifications.md](notifications.md)) deep-link here, and the target post may
  be nowhere near the first page of any feed — fetching it directly is the only
  reliable way to open an old thread. `?comment=<id>` on the page scrolls to and
  highlights a specific comment (auto-expanding its collapsed ancestors), so
  "someone replied" lands you on the exact reply, even one deep in the tree.

### Editing & deleting your own comment

Comments were **create-and-report-only** until issue #128: a typo was permanent
and a comment you regretted could only be removed by the maintainer, in the Django
admin. `PATCH`/`DELETE /api/comments/<pk>/` (`CommentDetailView`) closes that, on
both clients.

**The permission shape is `PostDetailView`'s, deliberately identical**: the author
may always edit or delete their own comment (the owner check runs *before* the
visibility gate, so you can still remove a reply you've lost sight of by
disconnecting from the author above it); a comment you can't see is a **404**; one
you can see but don't own is a **403**. `PATCH` takes `{"text": ...}` only —
`CommentEditSerializer` has no `parent` field precisely so a body can't re-parent
a comment into a branch of the tree it was never in.

`Comment.edited_at` works exactly as `Post.edited_at` does — null until the first
edit, stamped explicitly (never `auto_now`), and **a no-op edit doesn't stamp it**,
so the "· edited" marker only ever means a real change. **There is no edit window**,
unlike a message's 15 minutes: a comment sits on a page anyone can re-read at
leisure, so the honest disclosure is the marker, not a deadline — the window exists
in chat because a message is read once, in passing.

#### Delete is hard when it can be and soft when it must be

`Comment.parent` cascades, so hard-deleting a comment with replies would take
**other people's** replies down with it — which is not a thing your own delete
should be able to do. So the outcome depends on the thread:

- **No replies** → the row is deleted outright. The common case (a typo, a comment
  you regret) leaves nothing behind.
- **Has replies** → `text` is blanked and `deleted_at` stamped, leaving a
  **tombstone**: the thread renders a quiet "Comment deleted" with the replies
  still hanging off it.

The choice is made on **all** replies, not the ones a given viewer can see, so one
delete has one outcome for everybody. Either way the endpoint returns **204** —
which happened is a property of the thread, not of the request — and both clients
refetch rather than guess.

**A tombstone carries nothing but the shape it holds up.** The delete clears its
**reactions** (a blank placeholder can't carry them and can't take new ones) and
its **notifications** (each is a deep-link, and a link into an empty slot is the
dangling deep-link [notifications.md](notifications.md) promises never to render).
Nothing can be added to one either — replying, reacting and reporting a deleted
comment are all refused (400), the same rule a deleted message follows.

🔒 **Its reports deliberately survive**, and that's the one place the two delete
paths differ on purpose. Clearing them would hand a reported author a way to empty
the maintainer's queue on demand: reply to your own comment, delete it, and the
flag is gone before anyone read it — the evasion `Report.message_text` exists to
close for messages. A report isn't a deep-link, so nothing dangles: the row is
still in the admin, and "this was reported, then its author pulled it" is signal
worth keeping. The **hard** branch still cascades its reports away, matching a
deleted post since #62 — there the content really is gone with nothing left to
point at.

**A tombstone with no replies *this viewer* can see is hidden from them**, in
`build_visible_comment_tree`. It's carrying nothing for them and an empty
placeholder would be litter — and because the rule runs per viewer, the row left
behind when the last visible reply is later deleted needs no sweeping, it simply
stops rendering. A tombstone **counts toward `comment_count`** (it occupies a row
in the thread) but is **never `new_comment_count`** (there's nothing to read, and
badging it would send you to an empty slot).

#### The two clients

A comment's actions row is **`Reply · ⋯ · Show N replies`** on both, whoever is
looking. The ⋯ carries **Edit** and **Delete** on your own comment and **Report**
on someone else's — the shape a post header has had since #62, now drawn the same
way one level down. Report used to sit *inline* here while its two counterparts
went in a menu, which made one control look like two different kinds of thing
depending on whose comment you were reading; #128 moved it in on both clients.
Edit sits above Delete so the pointer heading for the safe action never crosses
the destructive one.

Both show the **"· edited"** marker next to the author line, and neither shows any
affordance on a tombstone **except the replies toggle** — hiding that would strand
the replies behind a row with no way in.

The menu itself is shared code on each client: `OverflowMenu.jsx` on the web
(portal, viewport flip, click-outside — lifted out of `PostMenu.jsx`, which had
the only copy) and `useActionMenu` on the phone. So is the delete confirmation:
`ConfirmDeleteDialog.jsx` on the web, `Alert` on the phone. Each takes its wording
from the caller, because what a delete takes with it differs — a post's photos, a
comment's replies — and a vague "this can't be undone" is the one thing the dialog
exists to make specific.

**The editors differ, and that part is deliberate.** The web flips the comment
into an inline editor; so does the app, which is the *opposite* of `PostEditModal`
and for exactly the reason that sheet exists. A post card lives in a virtualised
`FlatList`, where a row scrolled out of the window unmounts and takes a half-typed
edit with it. A comment thread renders inside the post screen's
`KeyboardAwareScroll`, where nothing unmounts, right next to a reply composer that
is already an inline `TextInput` — a sheet there would be a second pattern for the
same job, one step away from the first.

The app treats an **unchanged Save as a plain close** (no request), as it does for
posts and messages; the web still sends the no-op PATCH. Both disable Save on an
empty comment — a comment has no photo to fall back on, so emptying one is a
delete, and delete is its own control.

### Comment counts next to "Comments" (issue #63)

The **Comments** control on each post shows two numbers: the **total** comments
you'd see if you expanded the thread, and — in the accent colour — how many are
**new** since you last opened it (e.g. *Comments · 12 · 3 new*). Both ride the
feed payload, so nothing fires a request per post on feed load.

- **Serializer fields.** `PostSerializer` gains read-only `comment_count` and
  `new_comment_count`. They're **not** SQL annotations — they're computed once per
  page by `comment_counts_for_posts(posts, viewer)` and handed to the serializer
  via `context["comment_counts"]`. Absent from context (e.g. the create response)
  ⇒ 0, which is correct for a brand-new post.
- **Counts honour the exact same pruning as the thread.** The count must match
  what actually opens, so `comment_counts_for_posts` reuses
  `build_visible_comment_tree` (see [connections](connections.md#comments-threaded-connection-pruned)):
  a comment from a not-connected or deactivated author — *and its whole subtree* —
  is excluded. A plain `COUNT` can't express arbitrary-depth subtree pruning, and
  a naive author-filtered count would over-count a connected author's reply
  sitting under a hidden parent. Replies count toward the total (one number for
  the whole visible thread).
- **Cheap and page-size-independent.** One query loads every comment on the
  page's posts, one loads the viewer's last-seen markers; the trees are built in
  Python. This is wired in via `CommentCountMixin` on the feed, profile
  (`UserPostsView`), and group (`GroupPostsView`) timelines, and directly on
  `PostDetailView` so the `/p/:id` permalink carries the counts too.

**The "new" marker — `PostCommentRead`.** A new model, one row per `(post, user)`
with a single `last_seen_at`, deliberately the same shape as `ConversationRead`
(messaging). A comment is **new** to you if it's visible, authored by *someone
else*, and its `created_at` is after your `last_seen_at` for that post; a missing
row (thread never opened) makes every such comment new. Your own comments are
never "new" — you've self-evidently seen them, mirroring how unread message
counts exclude your own messages.

- **When "new" clears — on opening the thread.** `GET /api/posts/<id>/comments/`
  upserts your `last_seen_at` to now, so opening the thread clears its whole
  count at once (seen is thread-level, not per-comment) — consistent with how
  opening a conversation clears its unread badge. The upsert is wrapped to
  survive a concurrent-open race (two tabs both INSERT ⇒ one falls back to an
  UPDATE, not a 500).
- **Frontend keeps the badge honest via the cache, not a flag.** Once the tree
  has loaded, the client zeroes `new_comment_count` for that post in the cached
  feed / profile / group / permalink queries (`markPostCommentsSeen`), mirroring
  the server's reset without a refetch. The badge is then driven purely by that
  server-shaped count — so it clears on open **and** genuinely-new later comments
  re-badge once a refetch legitimately raises the count. (A per-card "already
  opened" flag would suppress those later comments until the card remounted.)
- **That write belongs to the request, not to the click.** On both clients it
  lives in `CommentThread`, never on the card that opens the thread. The stamp is
  a *side effect of the GET*, so anything hung off the tap runs ahead of it with
  nothing to roll back. Both clients shipped that way and both were wrong in
  their own shape: mobile cleared the badge when the *post* loaded (#195-era),
  the web cleared it in the toggle's `onClick` (#230) — click a card reading
  *· 3 new* with no signal and the badge went while the thread underneath read
  "Couldn't load comments.", leaving the card claiming three comments were read
  that the server still had unseen until the next feed refetch. It also removes
  the permalink's special case: `/p/:id` opens expanded, so it goes through the
  same query as a click does.
- **The write goes inside the `queryFn`, because having `data` is not the same as
  this fetch having succeeded.** `useQuery` hands back a cached tree
  *synchronously* on a reopen, so an effect gated on `data` fires on the stale
  tree before the refetch has been anywhere — and if that refetch then fails you
  have #230 again on the reopen path. A `queryFn` resolves exactly when the
  server stamped, which is the fact being mirrored. Both clients do it there now
  (web #306, app #307); the app's version marks the **event** twin from the same
  place, which the web has no equivalent of.
- **`markPostCommentsSeen` returns `undefined` from its updaters when there is
  nothing to change, and that is load-bearing.** `setQueryData` bails out on
  `undefined` and treats *any other* return — the identical object included — as
  a write, which dispatches a success and resets `isInvalidated` to false. The
  two helpers meet: posting a comment calls `invalidateComments` (marking every
  post list) and refetches the tree, and that refetch is what calls
  `markPostCommentsSeen`. Returning the data unchanged would therefore cancel the
  invalidation a tick after it was made, and the profile and group timelines
  would come back holding the old `comment_count`. Only `staleTime: 0` everywhere
  keeps that survivable today — and the app is where it can least be relied on,
  since a tab navigator keeps screens mounted. Both clients' four updaters
  decline with `undefined` (web #306, app #307, which also covers the event
  twin), and so does the app's only other no-op updater,
  `trimToFirstPage` in `mobile/src/lists.ts`. **That one was safe on an argument
  rather than a rule** — its four callers either `await refetch()` straight after
  or trim on unmount — and the argument rested on `staleTime: 0`, which is the
  crutch this bullet says can't be leaned on, so it now follows the rule instead.
  Declining costs it nothing; no caller wants a write when there's nothing to
  trim.
- **What that closes and what it doesn't.** The bail-outs decline, but a write
  that *does* have something to clear still resets `isInvalidated` on that one
  list. Closing that would mean re-invalidating the post lists immediately after
  — a refetch of every timeline on every thread open, which is the round trip the
  mirror exists to avoid — so the residue is deliberate and bounded: it needs a
  list holding this post with a live count at the moment the tree's refetch
  lands. It becomes visible the day a post list gets a `staleTime`.
- **`CommentThread` branches on the tree, not on the query flags.** Three states
  — we have a tree, we're never getting one, we're still waiting — and only the
  first can be rendered, so the tree decides and the flags only pick which way of
  having nothing to say this is. Both clients had a bug from getting that
  backwards, in opposite directions:
  - **The web crashed on a paused query.** Offline, with the default
    `networkMode: 'online'` neither client overrides, a query sits at
    `status: 'pending'`, `fetchStatus: 'paused'` — and `isLoading` is
    `isPending && isFetching`, so it reads **false with no data behind it**.
    Rendering the list on `!isLoading && !isError` hit `comments.length` on
    `undefined`, and with no ErrorBoundary anywhere in the tree (#299) that
    unmounted the whole app to a blank page (#306). Offline is the single
    likeliest way this request fails, so it now says so in words.
  - **The app dropped a thread it already had.** It returned on `error` *before*
    looking at the tree, and query-core's error action sets `status: 'error'`
    while keeping the data — so a failed foreground refetch of an open thread
    replaced the whole conversation with one line of red text and took the
    composer, and any half-typed reply, with it (#307). A failed refresh of
    something already on screen is not a reason to take it off screen.
  - The app's paused branch is **unreachable today and handled anyway**:
    `onlineManager` is deliberately left unwired to NetInfo (see
    `mobile/src/app/_layout.tsx` for the long list of things wiring it would
    break), so an offline GET rejects rather than pausing. Wiring it is a
    one-liner, and the failure here would be a spinner that never stops.
  - **The same rule has to hold one level up, or the thread's care is undone from
    above.** `mobile/src/app/post/[postId].tsx` returned on its own query's
    `error` before it looked at the post it had, so a failed refetch of
    `['post', id]` replaced the card, the thread *and* the half-typed reply — and
    that refetch is routine, since `invalidateComments` invalidates that very key
    on every comment write. It renders the post it has; a **404** still outranks
    the cached copy, because that's an answer about now (deleted, or out of
    reach), not a failure to ask.
  - **It's a whole-client rule, not a comment-thread one, and it holds on both
    clients.** The same defect was at seven more places in the app (#309) and at
    seven on the web (#310), and is fixed in both. See *Branch on the data, not
    the query flags* in `mobile-app.md` for the rule, the shape, and the two
    idioms that only look wrong; the web's sites are listed just below.
- **That cache write matches on the first key segment, not the whole key** —
  `setQueriesData` with a predicate over `{feed, userPosts, groupPosts}`, on both
  clients (`frontend/src/postCache.js`, `mobile/src/postCache.ts`). Every post
  list caches under a *suffixed* key the writer can't know: `['feed',
  includeGroups]`, `['userPosts', id]`, `['groupPosts', id]`. An exact-key
  `setQueryData(['feed'], …)` matches none of them and updates nothing without
  erroring — mobile shipped that way and the badge simply never cleared (#195).
  Tests for this must seed the suffixed keys; a bare `['feed']` fixture tests a
  cache entry neither app ever writes.
- **The *total* is a separate problem from the badge, and it's an invalidation,
  not a cache write.** Opening a thread only moves `new_comment_count`, which the
  client can compute itself; adding or deleting a comment moves `comment_count`,
  and only the server knows the new value after pruning. So every mutation on the
  tree must invalidate the post lists as well as `['comments', postId]` — the
  count rides the *post* payload, not the tree. Both clients funnel both
  mutations through one `invalidatePostComments(queryClient, postId)`
  (`frontend/src/postCache.js`, `mobile/src/postCache.ts`), which derives its
  list keys from the same `POST_LIST_KEYS` set `markPostCommentsSeen` uses, so a
  new post-list surface can't reach one and not the other. The bug this closes
  (#215 on web, #273 on mobile) was exactly the drift a shared list prevents:
  delete carried the full set, add carried part of it, and a card sat reading
  *Comments · 3* above four comments until something unrelated refetched.
- **Note the two helpers match keys in opposite directions**, which is the
  easiest thing here to get backwards. `markPostCommentsSeen` *writes*, so it
  needs the exact suffixed key and reaches the lists through a predicate;
  `invalidatePostComments` *invalidates*, which prefix-matches, so a bare
  `['userPosts']` correctly reaches `['userPosts', 7]`.
- **What the invalidation actually buys is the mounted screen.** With
  `staleTime` at 0, a timeline that has been unmounted refetches on its next
  mount anyway — but a native stack keeps the screen you came *from* mounted
  while you read a post, so without the invalidation its query never refetches
  and going back shows the old count. That's the reported symptom of #273, and
  it's why the mobile regression test mounts observers rather than seeding cache
  entries. (A seeded, unobserved entry passes against the broken build.) One
  consequence worth knowing before debugging near this: the seen-marking write
  fires a tick after the tree refetches and `setQueryData` clears
  `isInvalidated`, so on an *unobserved* query the flag is cleared again shortly
  after being set. Harmless at `staleTime` 0 — but don't write a test that waits
  on that flag.

### Branch on the data, not the query flags — the web's seven sites

The rule and the reasoning are written up once, under the same heading in
[`mobile-app.md`](mobile-app.md); this is the web half of it. **`main.jsx` builds
a bare `new QueryClient()`**, so `staleTime` is 0 and `refetchOnWindowFocus` is
on: coming back to a tab that has been sitting open refetches everything mounted
in it. While the box is restarting — which publishing a GitHub Release does
(`deploy.md`) — those refetches fail. That is the trigger, and it's routine.

Reading `isError` before the data therefore threw working content away in five
places, and #310 fixed all of them by branching on the data instead, with a
**404 still outranking the cached copy**:

- **`components/messages/ConversationThreadView.jsx`** — the costly one, exactly
  as on the app: the transcript, the header identity *and* the composer with a
  half-typed reply in it, replaced by "Couldn't load this conversation." and a
  *Back to messages* button, having lost nothing server-side. `gone` (a 404) and
  `loadFailed` (`isError && !detail`) are named once and drive all three render
  sites.
- **`components/DisconnectWarningModal.jsx`** — the dangerous one, again as on
  the app: the concrete list of chats you're about to be thrown out of, swapped
  for "You can still continue" in front of a destructive action with Confirm
  still live. Guarded with `isError && !impactQuery.data`, matching the app
  line-for-line.
- **`pages/GroupFormPage.jsx`** — the one that destroys typing. `name` and
  `description` are component state seeded once from the query, plus a chosen
  avatar and its crop; the early return unmounted the form and took a rewritten
  group description with it, and nothing persists a draft. A 404 still wins:
  there is nothing left to save the edit to.
- **`pages/ProfilePage.jsx`** and **`pages/GroupPage.jsx`** — the whole profile;
  the group's timeline, upcoming events and calendar.

And two on the *other* side of the same rule — a missing thing and an
unreachable one are different answers:

- **`pages/EventPage.jsx`** had one `isError` branch doing both jobs, and with
  `retry: false` on the query, a single dropped packet on the first load told
  you the event "may have been cancelled" — something the client has no way of
  knowing. Only a 404 says that now.
- **`pages/PeoplePage.jsx`**'s three `useInfiniteList` segments returned on
  `isError` before looking at `items`, so a failed *page two* took every row you
  were reading with it, and "you're not connected with anyone yet" was said on
  the strength of a request that failed. They now use the shape `FeedPage` and
  `GroupsDrawer` already had for this hook: rows, then the error as an extra
  line under them, then the empty state gated on `!isError`. The Requests
  segment lost something extra on the way out — `decideError`, the message
  saying an Approve or Reject was refused, renders below the old early return,
  so a list refetch failing in the same frame took the write's own error off
  screen with it (#231's shape, by another route).

Two consequences worth knowing:

- **The mark-read guard had to change with it, and `!!detail` is not the
  replacement.** `convoQuery.isError` in `ConversationThreadView`'s mark-read
  effect used to mean the same thing as "nothing is on screen". Once a failed
  refetch keeps the thread up, it doesn't — the reader is looking at the
  messages while the effect returns early, and the tab badge goes on claiming
  unread mail they have just read. But swapping in a bare "have we got a detail"
  check is wrong in the other direction: a **404** doesn't clear the cached
  detail either, so it stays truthy while the render branches have all switched
  to *This conversation isn't available*, and the effect would fire a doomed
  write for a conversation showing nothing. `gone`, `loadFailed` and the
  `showingThread` derived from them are declared once, up beside the data, and
  the effect and the render branches both read that same value — a second
  phrasing of the same question is how the two halves of a file drift apart.
  `markConversationRead` carries a `.catch()` besides, since the old guard was
  what used to keep the write off a failing connection. The app made the first
  half of this correction in #311 and the 404 half in #315, declaring the same
  three flags in one block so no site re-derives the answer — see *Ask "is it on
  screen" once, not twice* in [`mobile-app.md`](mobile-app.md).
- **A failed refresh stays silent** while stale content is up, on both clients —
  see the app's doc for why a banner was weighed and declined.

### The mirror image: no error branch at all — the web's sites

The other half of the same family, and the one that reads worse. Where the
sites above threw *away* content they had, these state as **fact** something
they never heard back about: the query fails, `data` is undefined, the derived
array defaults to `[]`, and an empty state written as a flat sentence renders.
Fixed for the web in #314 (the app's two worst sites went in #312; the rest are
#317).

**Offline it paints instantly, with no spinner.** `main.jsx` builds a bare
`new QueryClient()`, so `networkMode` is the default `'online'` and an offline
query sits **paused** — `status` stays `pending`, `fetchStatus` goes to `paused`,
the request is never *sent*, and `isLoading` (`isPending && isFetching`) is false
with no data behind it. So `!isLoading && !isError` is *not* enough on its own,
which is #306's lesson; a branch that only handles "loading" and "errored"
leaves the empty state as the fall-through for "we haven't asked yet".

**Which is why the waiting branch is gated on `!data`, not on `isLoading`.** The
first cut of #314 got the error branch right and left the loading branch reading
`isLoading`, so the paused case still fell through to the empty state — the exact
bug, on the exact screens, with the fix already in the file. Caught in review.
The full shape, and the order matters:

```jsx
loadFailed ? <error + retry/>            // isError && !data
  : !data ? <p>{waitingMessage(q)}</p>   // pending *or* paused
  : items.length === 0 ? <empty/>        // an answer, and it was none
  : <content/>
```

`waitingMessage()` (`errors.js`) is the shared wording: "Loading…" while a
request is genuinely out, "Waiting for a connection…" when it hasn't been sent
and won't be until the signal returns. Two sentences because they ask two
different things of the reader, and because a spinner that never resolves and
never explains is its own dead end. `CommentThread.jsx` is the original, written
inline there for #306.

Eleven sites, plus the photo gallery found in the same sweep, all fixed by
naming `loadFailed = isError && !data` next to the query and branching on it
before the empty state — `!data`, never a bare `isError`, or it becomes the
mistake above. Retries where the surface has room: `CalendarPage` (an *empty
month grid* is the most confident possible lie about a calendar), `GroupPage`'s
posts, upcoming, past events and calendar, `ProfilePage`'s posts (which named a
person: "*Ada* hasn't posted yet"), `ActivityCenter`, `GroupMembersPanel`,
`NotificationPreferencesSection`, `ConversationThreadView`'s transcript ("No
messages yet — say hello." in a thread with years of history), and
`ConversationInfoView` — where one `!detail` branch was doing two jobs and told
you a chat you were actively in wasn't available.

Two of them reached past the display, and both took the #307/#308 answer:

- **`ActivityCenter` also marks everything seen**, and the badge is a *separate*
  query. If the count poll succeeded and the list fetch failed, the bell read
  "Activity, 5 unread" over a panel saying you were all caught up — and the
  effect cleared every unread server-side anyway, so the badge that would have
  brought you back was gone and the screen had just told you there was nothing
  to come back for. The write now waits on the list landing (`listLoaded`, the
  same value the render branches read), fires once per open, and carries a
  `.catch()`. Same turn the app's activity screen took in #312.
- **`GroupPage`'s "Start a chat" turned a failed read into a wrong write.**
  `memberIds: (membersQuery.data ?? []).map(…)` made "we couldn't ask who's in
  this group" into "this group has nobody in it", so the chat was created with
  an empty member list. It refuses and says so now. (The app's twin, on
  `groups/[groupId]/invite.tsx`, is in #317.)

**#319 missed two sites in the messaging panels, and #324 finished them** — same
root cause, found in the sweep behind the app's #323:

- **`ConversationInfoView`'s Block control** was gated on `otherQuery.data` with
  that query's `isError` read nowhere in the file, so a failed profile fetch
  removed the control with no explanation — the omission variant again, and the
  worst one to date, because the person reaching for it is reaching for a safety
  control. It stays absent as a *button* (see
  [`messaging.md`](messaging.md#photos-the-list-and-the-info-panel-on-the-web-phase-9b-m9e)
  for why a `BlockButton` without `is_blocked` is worse than none) and says it
  couldn't check instead.
- **`ConversationThreadView`'s mark-read write** was gated on `showingThread`,
  which answers for the *conversation*, not the transcript it claims has been
  read — so the POST went out under a "Couldn't load these messages" card. The
  guard is `showingThread && !!pages`, and **`!!pages`, not the failure flag**,
  is the load-bearing part: gating on `!messagesLoadFailed` still fires while the
  request is in flight, before anyone knows it failed. That's the same trap the
  app's post and event screens record (#318), and it's why a guard there wasn't
  enough either.

**Badge-shaped counts are deliberately left alone** — `Layout.jsx` (nav unread),
`GroupsDrawer.jsx` (the invite banner) and `PeoplePage.jsx` (the Requests count)
are all `data?.count ?? 0`, so a failed poll reads as zero. Decided rather than
missed: a badge is an *absence*, there's no sensible error affordance on a nav
pip, and a count frozen at a stale value is worse than none. Note the app's
`useBadgeCount.ts` makes the **opposite** call for the *app-icon* badge, with a
"Not `?? 0`" comment saying why — that one is the OS's own surface and re-asserts
a known count rather than clearing it. Don't "fix" either to match the other.

Sites that already get this right and shouldn't be "fixed": `FeedPage`,
`GroupsDrawer`, `NewChatPicker`, `ConversationListView`, `ReactorsPopover`,
`PostPage`, `GroupInvitesPage`, `MessageStrandPanel`, `GroupInvitePicker`, and
`components/events/EventPhotos.jsx` (the best example in the repo — a cold-load
error branch *and* a separate "couldn't load all the photos" line under a
rendered grid).

## Photos

- **`PostImage`** table (FK to `Post`) — **many photos per post**, not a single
  field. Uploaded as repeated `images` in the multipart `POST /api/posts/`. Feed
  and profile serializers embed each as `{id, image, thumbnail, width, height}`
  with absolute URLs.
- A post can be **photo-only** (no text).
- **Avatars** surface as a small square `avatar_thumb` on post/comment authors,
  the people list, and profile headers; `Avatar.jsx` renders the photo when
  present, else a coloured initial.
- **The post's marker on the timeline rail is the poster's avatar** (issue #64),
  not a plain dot — a warmer, scan-by-face cue that fits the "living line" look.
  It's an `Avatar size="xs"` in a profile link (`.tl-avatar-node`), centred on
  the spine with the same right-offset formula the old dot used (so it stays
  threaded at any gutter width); a surface-coloured halo separates the bead from
  the line, and hover adds an accent ring — both on the avatar element itself so
  they hug the visible circle. The avatar link is decorative (`tabIndex=-1` +
  `aria-hidden`) — the author's name beside it is the single accessible link to
  the profile, matching the avatar+name pattern in `CommentThread` /
  `GroupMembersPanel`. The **day-divider** dots (`.tl-day-dot`) stay plain.
- **The compose box mirrors this**: the pulsing green **"now"** node (`.tl-node`,
  TimeLine's live-tip "logo") is lifted to cap the top of the line, and *your own*
  avatar hangs on the spine just below it (same `.tl-avatar-node`), so the live
  end of the timeline reads like every other entry. The compose avatar gets no
  accent hover ring — that rule is scoped to `.tl-entry`, so `.tl-compose` reuses
  the class and gets a plain bead for free.
- **On mobile the compose box aligns to the spine in two bands** (`ComposeBox.tsx`),
  because the eye pairs each spine element with whatever sits beside it: the word
  **"now"** is level with the pulsing node (the node *is* now), and the **text
  box** is level with your avatar bead (that's you, about to write). Both centres
  are computed from the constants the spine column is built from rather than
  nudged by hand, so changing the node size or the bead gap moves the body with
  them. `BEAD_GAP` is deliberately wider than the node needs — it's what keeps
  the two pairs reading as two statements rather than one stack.
- **"Add photos" on mobile offers the camera as well as the library**, through
  the shared `usePhotoPicker` — see
  [`mobile-app.md`](mobile-app.md#taking-a-photo-camera-or-library) for the
  contract and for why the sheet is a menu rather than an `Alert`. The composer
  is the only caller that takes **several** photos at once (multi-select is
  library-only; the camera returns one shot) and the only one that picks at
  `quality: 0.9` — a post photo is uploaded as picked, so that's the one
  compression it gets, whereas chat photos and avatars are re-encoded on the
  phone afterwards and take the full-quality pick.

### Photo layout & the full-screen viewer

Both clients follow the same two rules, because both hit the same problem: a
post may carry up to ten photos, and rendering them full-width each turns one
entry into screens of scrolling, which buries the rest of the timeline.

**Both the grid and the viewer are now shared with [events](events.md)**, whose
albums hit exactly the same problem with a bigger set. `PhotoGrid`
(`frontend/src/components/PhotoGrid.jsx`, `mobile/src/components/PhotoGrid.tsx`)
was lifted out of `PostCard` on each client so the two can't drift; it takes an
optional `max`/`total` pair for the album's "+N more" overlay, and
`Lightbox`/`PhotoLightbox` gained an optional caption (an album photo has an
author of its own — a post's images inherit the post's) and an optional Remove.
A post passes none of those, so its grid and viewer are unchanged.

- **One photo keeps its natural shape; several go into a two-column square
  grid.** The grid is *navigation* — a compact index of what's in the post — and
  is deliberately not where a photo gets looked at. Cost per post is then bounded
  no matter how many photos it has.
- **Tapping/clicking a photo opens a full-screen viewer** at that photo, loading
  the full-size `image` rather than the grid's `thumbnail`. On the web
  (`Lightbox.jsx`) you flip with arrow buttons or ← / →, and Esc / the × / the
  backdrop close it. On mobile (`PhotoLightbox.tsx`) you **swipe** — arrows mean
  nothing on a phone — with a × top-right and an `n / total` counter.

Two things worth knowing about the mobile viewer:

- It mounts a **`SafeAreaProvider` of its own inside the `Modal`**. React Native
  renders a Modal in a separate native view hierarchy, so it sits outside any
  provider mounted around the app; nesting is the documented fix, and it also
  means no screen has to wrap itself for the chrome to clear the notch.
- **Photos sit outside the card's own `Pressable`** (as the reaction chips
  already did). Nested pressables make "did I open the post or the photo?" a
  matter of touch-responder luck; side by side, the two targets can't collide.

### The imaging pipeline (`api/imaging.py`)

All image handling — post photos, **event album photos** and avatars — funnels
through `process_image`, the single place the safety rules live:

- **Validate by decoding, not by extension/Content-Type.** A file is accepted
  only if Pillow opens it *and* its format is in a raster allow-list
  (JPEG/PNG/WebP/GIF/MPO/HEIF). **SVG is rejected** — a script-bearing vector
  would be stored XSS. Rejections name the detected format and the accepted ones,
  so "which photo, and convert it to what?" is answerable.
- **EXIF (including GPS) is stripped** by re-encoding from raw pixels, after
  applying the orientation tag so photos aren't stored sideways. Phone photos leak
  home location otherwise — a real privacy win, covered by a test.
- **HEIC/HEIF is accepted and transcoded** (issue #41). It's the *default* iPhone
  photo format, so rejecting it turned away the photos this app's actual audience
  takes — and because iOS only *sometimes* converts to JPEG on the way out
  (depending on browser, pick method, and the Camera "Most Compatible" setting),
  it presented as an intermittent "some of my photos won't upload". `pillow-heif`
  registers a HEIF opener at import of `imaging.py` — not in `AppConfig.ready()`,
  so it cannot be missing whatever the app-loading order. Everything downstream is
  unchanged: a HEIC is stored as an ordinary JPEG with metadata gone, which also
  means browsers that can't display HEIC (most) still render it. The prebuilt
  manylinux wheels bundle libheif, so **the backend image needs no apt packages**.

  > **Trap, if you touch orientation.** A real iPhone HEIC is decoded *upright*:
  > pillow-heif/libheif bake the camera's rotation into the pixels on open and
  > reset the EXIF orientation to 1. Plain `ImageOps.exif_transpose` is therefore
  > exactly right for both formats — it rotates a JPEG (whose pixels are still in
  > sensor orientation) and correctly no-ops on an already-upright HEIC. **Do not**
  > re-apply `info["original_orientation"]`: on a real iPhone photo that stashed
  > flag's rotation is already in the pixels, so re-applying it rotates a second
  > time and stores every portrait sideways — permanently, since we strip the flag.
  > This actually shipped once (a `_apply_orientation` helper did exactly that) and
  > hid behind a green test, because a HEIC written by pillow-heif's *own* encoder
  > leaves its pixels un-rotated — unlike any real camera. The regression test now
  > uses an already-upright fixture and asserts the dimensions come out unchanged.

- **Bounded:** ≤30 MB per input file, ≤10 photos per post (and ≤10 per *request*
  on an event album, which additionally caps the album itself at 200 — a
  per-request limit can't bound a collection many people add to over time; see
  [events](events.md)); originals downscaled
  (long edge 2048), thumbnails generated (512 post / 128 square avatar).
  Processing is **synchronous** — fine at family scale; move to Celery if volume
  grows.
- **Why 30 MB and not a tighter cap:** `MAX_UPLOAD_BYTES` is a **DoS/memory
  guard** (stop a client streaming an unbounded file into Pillow), *not* a storage
  limit — every accepted photo is already downscaled + re-encoded at JPEG q85, so
  the *stored* file is well under 1 MB regardless of input size. Modern phone
  photos routinely exceed 10 MB, so the input ceiling is phone-realistic and
  compression handles actual storage/bandwidth. (Note: no other layer blocks large
  uploads — Caddy sets no request-body limit, and Django streams file uploads to a
  temp file, bypassing `DATA_UPLOAD_MAX_MEMORY_SIZE`.) HEIC transcode is a separate
  future item (needs `pillow-heif`/`libheif`).

## Profiles

- A profile page (`/u/:id`) shows the person's name, avatar, bio, and their posts
  (gated by connection — see [connections](connections.md); a non-connection sees
  a locked state, and a `getUser` 404 shows "not found" while other errors show a
  retryable state so a transient blip doesn't claim the account doesn't exist).
- **Profile editing rides dj-rest-auth's existing `PATCH /api/auth/user/`** (no
  new endpoint). `UserDetailsSerializer` writes first/last name + bio and accepts
  an `avatar` upload (processed like a post photo), with `remove_avatar` to clear
  it. The edit PATCHes multipart, then refetches "who am I" so the new name/avatar
  propagate everywhere immediately.
- **You edit your profile in place, on your own profile page** (issue #53). An
  "Edit profile" button flips the header into `ProfileEditForm` (name / bio /
  avatar) and saves without leaving `/u/:id` — a profile is public-facing info, so
  you edit it where you (and everyone else) see it. There's no separate
  profile-edit route; `/settings` is now **account/security only** (notification
  prefs, password change, account deletion — see [accounts](accounts.md)).

### Avatar reframing (client-side crop)

Avatars are shown as circles (`Avatar.jsx` masks the square `avatar_thumb` with
`rounded-full`), so how the square is cut matters. Rather than letting the
backend blindly centre-crop, choosing an avatar first opens **`AvatarCropModal`**
(built on `react-easy-crop`): drag to reposition, zoom with a slider / mouse
wheel / two-finger pinch, inside a **round** cutout that dims everything outside
it — a live preview of the circle people will actually see (issue #18). On
confirm, the browser draws the chosen square to a canvas and uploads *just that
square* (`cropImage.js`), capped at 1024px and re-encoded as JPEG.

- **Why client-side, not "upload original + crop coords":** no new endpoint, DB
  field, or migration — the smaller, boring option for a family-scale app. The
  trade-off is we don't keep the uncropped original for later re-cropping.
- **The server pipeline is unchanged and still authoritative.** The cropped file
  goes through the same `process_image` (validate-by-decode, EXIF strip,
  size/format caps). The crop is *framing only*; `thumb_square` centre-crop still
  runs but is a no-op on an already-square upload.
- **Shared by user and group avatars** — the same modal wires into both
  `ProfileEditForm` and `GroupFormPage`, since both render the same circle.
- **On mobile the photo can come from the camera**, not just the library
  (shared `usePhotoPicker`, see
  [`mobile-app.md`](mobile-app.md#taking-a-photo-camera-or-library)) — a profile
  photo is the picture people most often want to take on the spot. Either source
  hands the **full** image to the cropper, never the OS square crop, because
  reframing is the whole point.
- **Undecodable files fail early with a message.** The modal probes whether the
  browser can decode the chosen file; if not (an unsupported type the file picker
  let through — e.g. HEIC on a browser without HEIC support — or a corrupt file),
  it shows "that file couldn't be opened, try a JPEG/PNG/WebP/GIF" instead of a
  cropper that never lets you continue. The backend still rejects the same files;
  this just surfaces it before the user tries to save.

## Storage & media serving

- Media goes through **`django-storages`** so the backend is swappable **by
  config**, not a rewrite: **local disk** now (and through the home-server beta),
  becoming an **S3 bucket** at the AWS migration (Phase 11) via the `STORAGES` seam
  keyed on `DJANGO_MEDIA_STORAGE`. Keep storage **private** (not publicly
  listable).
- **Filenames are unguessable UUIDs** (`upload_to`), so a raw media URL can't be
  found by walking ids.
- **Media is auth-gated in production.** Caddy `forward_auth`s every `/media/*`
  request to `GET /api/media-auth/`, which returns 204 only for a logged-in
  **active** member (SimpleJWT already rejects a deactivated user's token, so a
  banned member's saved URLs stop resolving); an unauthenticated request gets 401.
  A leaked URL is useless to a logged-out stranger. In *dev*, Django serves
  `/media/` openly (DEBUG-only convenience, **not** access control). See
  [deploy.md](../deploy.md) for the Caddy side. **Deferred to Phase 11:** full
  *per-author connection* gating of media (a logged-in member could still fetch a
  photo whose UUID they hold) — accepted for a small closed beta, with the UUID as
  a second layer; real private/signed S3 media lands with the AWS migration.
