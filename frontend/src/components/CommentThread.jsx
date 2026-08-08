import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Avatar from "./Avatar.jsx";
import ConfirmDeleteDialog from "./ConfirmDeleteDialog.jsx";
import OverflowMenu, { MenuItem } from "./OverflowMenu.jsx";
import ReactionBar from "./ReactionBar.jsx";
import { ReportModal } from "./ReportModal.jsx";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import { serverMessage } from "../errors.js";
import {
  commentsQueryKey,
  invalidateComments,
  markPostCommentsSeen,
} from "../postCache.js";
import { formatRelativeTime, formatAbsoluteTime } from "../utils.js";

// The set of comment ids that are *ancestors* of `targetId` — the nodes whose
// replies must be expanded for the target to be visible. Replies start collapsed
// (see CommentNode), so a deep-linked reply 20 levels down would otherwise be
// hidden inside collapsed parents; expanding its ancestors reveals it.
function ancestorIdsOf(comments, targetId) {
  const found = new Set();
  function walk(nodes, trail) {
    for (const node of nodes) {
      if (node.id === targetId) {
        trail.forEach((id) => found.add(id));
        return true;
      }
      if (node.replies?.length && walk(node.replies, [...trail, node.id])) {
        return true;
      }
    }
    return false;
  }
  walk(comments, []);
  return found;
}

// The depth at which a level's step right shrinks (`--tl-c-indent-deep`), so a
// deep thread doesn't march off the side of a narrow screen. Replies start
// collapsed, so more than a couple of visible levels is rare in practice.
const DEEP_FROM = 4;

// The comment tree for one post, drawn as the living line one level down.
//
// **The shape is the point.** The post's spine runs on down behind the thread;
// each comment reaches out to its parent's line with a curved elbow that lands
// on its own face; a comment with replies grows a spine of its own. So reply
// depth is read off *which* vertical line a comment hangs from, not off
// indentation alone — the same shape, and the same reasoning, as a file tree.
// Who you're replying to is the single most important thing a thread has to
// communicate. The geometry (and the traps in it — chiefly that comments must
// never be spaced with a `gap`, which shows up as a break in the line) lives
// with the rest of the spine mechanics in `index.css`, under "the line, one
// level down"; `docs/design-system.md` has the why, and the app's
// `mobile/src/components/CommentThread.tsx` the full derivation.
//
// The backend returns an already-pruned nested tree: you only ever receive
// comments (and replies) from people you're connected with — a not-connected
// author's comment and everything under it is dropped server-side, so there is
// no hidden content here to leak (issue #12). The frontend just renders what it
// gets, nesting `replies` under each comment.
//
// `target` is `{ postId }` or `{ eventId }` — the thing the thread hangs off.
// A comment tree is the same feature on both, and the server applies the same
// prune to both; only which gate lets you reach it differs, and that is entirely
// the server's business. So this component takes the target as data and never
// branches on it: everything below (reply boxes, edit, delete, reactions, the
// deep-link) works unchanged because a comment id is a comment id.
//
// `highlightCommentId` (from the /p/:id permalink's, or the event page's,
// ?comment=) deep-links to one comment: its ancestors are auto-expanded, it's
// scrolled into view, and it pulses briefly so the eye lands on it — the point
// of a "someone replied" link.
export default function CommentThread({ target, highlightCommentId = null }) {
  const queryClient = useQueryClient();
  const {
    data: comments,
    isPaused,
    isError,
    error,
  } = useQuery({
    queryKey: commentsQueryKey(target),
    // **The seen-write is bolted to the request, not to a render.**
    //
    // The server stamps your `last_seen_at` as a *side effect of this GET*, so
    // the cache write that mirrors it has to be the resolution of this GET and
    // nothing else. Hanging it off the card's click ran it before the request
    // was even issued, with nothing to roll back (#230): the "· 3 new" badge
    // went, the thread underneath read "Couldn't load comments.", and the card
    // then claimed you'd read three comments the server still had unseen —
    // with no trace of them once you collapsed it again.
    //
    // An effect on `data` isn't the same thing and isn't enough. `useQuery`
    // hands back a cached tree *synchronously* on a reopen, so an effect fires
    // on the stale tree before the refetch has been anywhere — and if that
    // refetch then fails, you have the bug above again on the reopen path. The
    // stamp happens exactly when this function resolves; so does the mirror.
    // (The app's twin does the same, from the same place, as of #307 — it marks
    // the event target from there too, which is the half the web doesn't need.)
    //
    // Only a post carries a "N new" badge the web mirrors; an event's lives on
    // `groupEvents` / `personalCalendar`, which are only ever rendered by a
    // screen you have to navigate *back* to, and that refetches on mount at
    // staleTime 0. Give any of those a staleTime and this needs the event twin
    // the app already has (`markEventCommentsSeen`).
    queryFn: async () => {
      const tree = await api.getComments(target);
      if (target.postId != null) {
        markPostCommentsSeen(queryClient, Number(target.postId));
      }
      return tree;
    },
  });

  // Which comment to visually highlight; cleared after a moment so the pulse
  // fades. Initialised from the prop — the parent remounts this thread with a
  // `key` tied to the target, so a new deep-link re-arms the highlight cleanly.
  const [highlightId, setHighlightId] = useState(highlightCommentId);

  // Once the tree is loaded, scroll the target into view and let the pulse fade.
  useEffect(() => {
    if (!highlightCommentId || !comments) return;
    const el = document.getElementById(`comment-${highlightCommentId}`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    const timer = setTimeout(() => setHighlightId(null), 2600);
    return () => clearTimeout(timer);
  }, [comments, highlightCommentId]);

  const expandIds =
    highlightCommentId && comments
      ? ancestorIdsOf(comments, highlightCommentId)
      : null;

  // **Branch on the tree, not on the flags.** The three states are "we have a
  // tree", "we're never going to get one" and "we're still waiting", and only
  // the first of them can be rendered — so `comments` decides, and the flags
  // only choose which way of having nothing to say this is.
  //
  // Driving it off `!isLoading && !isError` instead was a crash waiting for a
  // train journey. A query the *browser* has paused — offline, `networkMode`
  // 'online', which is the default this app never overrides — sits at
  // `status: 'pending'`, `fetchStatus: 'paused'`, and `isLoading` is
  // `isPending && isFetching`, so it reads **false** with no data behind it.
  // Both flags false, no tree: `comments.length` threw, and with no
  // ErrorBoundary in the tree (#299) that unmounted the whole app to a blank
  // page. Being offline is the single likeliest way this request fails.
  //
  // The other way round matters too: a *background* refetch that fails still
  // has the tree it loaded a minute ago. Dropping to the error line there threw
  // away comments the user was reading and a reply they were half-way through
  // typing, because the composer went with it. A failed refresh of something
  // already on screen is not a reason to take it off screen.
  return (
    <div className="tl-thread">
      {!comments &&
        (isError ? (
          <p className="tl-thread-foot text-sm text-red-600">
            {serverMessage(error, "Couldn't load comments.")}
          </p>
        ) : isPaused ? (
          <p className="tl-thread-foot text-sm text-ink-faint">
            Waiting for a connection…
          </p>
        ) : (
          <p className="tl-thread-foot text-sm text-ink-faint">
            Loading comments…
          </p>
        ))}

      {comments && (
        <>
          {comments.length === 0 ? (
            <p className="tl-thread-foot text-sm text-ink-faint">
              No comments yet. Start the conversation.
            </p>
          ) : (
            // No spacing utility here, deliberately — see `.tl-comment-list`.
            <ul className="tl-comment-list">
              {comments.map((comment, index) => (
                <CommentNode
                  key={comment.id}
                  comment={comment}
                  target={target}
                  expandIds={expandIds}
                  highlightId={highlightId}
                  // The line these hang off is the *post's* spine; the thread's
                  // own offset puts it exactly where any other comment finds
                  // its parent's line, so top-level needs no special case.
                  isLast={index === comments.length - 1}
                />
              ))}
            </ul>
          )}

          {/* Top-level composer (a comment on the post itself). */}
          <div className="tl-thread-foot mt-2">
            <CommentComposer target={target} placeholder="Write a comment…" />
          </div>
        </>
      )}
    </div>
  );
}

// One comment: a face on its parent's line, with its replies branching off its
// own. Replies start *collapsed*, so a busy post opens as a clean list of
// top-level comments and you drill into just the sub-thread you want — much
// easier to follow (and less overwhelming) than a wall of nesting. Opening the
// reply box, or having posted a reply, reveals the sub-thread so you always see
// your own reply.
//
// **Everything but Reply lives behind a ⋯** (issue #128), so the actions row is
// `Reply · ⋯ · Show N replies` whoever is looking: your own comment's menu
// offers Edit and Delete, someone else's offers Report. That's the shape a post
// header already had, and both clients now draw it — Report used to sit inline
// here while its two counterparts went in a menu, which made one control look
// like two different kinds of thing depending on whose comment you were reading.
// Edit sits above Delete so the pointer heading for the safe action never
// crosses the destructive one.
//
// A **deleted** comment arrives as a tombstone: blank text with `deleted_at`
// set, kept only because replies hang off it. It renders as a quiet placeholder
// and offers nothing — no reply, no menu, no reactions — except the toggle
// that opens the replies it exists to hold up.
function CommentNode({
  comment,
  target,
  expandIds = null,
  highlightId = null,
  depth = 0,
  // Last of its siblings, so the parent's line stops here rather than carrying
  // on to a comment that isn't there — that's what ends a run on a face.
  isLast = true,
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const replies = comment.replies ?? [];
  const [showReply, setShowReply] = useState(false);
  const [editing, setEditing] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const isDeleted = comment.deleted_at != null;
  const isOwner =
    !isDeleted && user != null && user.pk === comment.author.id;

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteComment(comment.id),
    onSuccess: () => {
      // The thread refetches because only the server knows whether the row went
      // or became a tombstone. The post's `comment_count` moved too, and that
      // rides the post payload — so the lists showing it need invalidating just
      // as deleting a post does. Both live in one helper (#215).
      invalidateComments(queryClient, target);
      // **Close the dialog explicitly**, unlike `PostMenu`, which can leave it
      // to the card unmounting. A comment that had replies survives its own
      // delete as a tombstone, so this node stays mounted through the refetch —
      // and a confirm left open on a `pending` that never clears again is a
      // modal with Escape and the backdrop both disabled. Closing here also
      // retires the button, which is what `pending` was guarding against.
      setConfirmingDelete(false);
    },
  });
  // Replies start collapsed — unless this node is an ancestor of a deep-linked
  // target (expandIds), in which case it opens so the target is reachable.
  const [collapsed, setCollapsed] = useState(
    replies.length > 0 && !(expandIds && expandIds.has(comment.id))
  );
  const isHighlighted = highlightId != null && comment.id === highlightId;
  const showReplies = replies.length > 0 && !collapsed;

  return (
    <li
      id={`comment-${comment.id}`}
      className={`tl-comment${depth >= DEEP_FROM ? " tl-comment--deep" : ""}`}
    >
      {/* Out from the parent's line and down onto our own face. Every comment
          has one, including top-level, whose parent line is the post's spine. */}
      <span className="tl-branch" aria-hidden="true" />

      {/* The parent's line carried past us — the whole node, replies and all,
          so it reaches the sibling below rather than stopping at our text. */}
      {!isLast && <span className="tl-cline tl-past" aria-hidden="true" />}

      <div className="tl-comment-row">
        {/* Our own line, from our face down to where our replies start. There's
            nothing to hold up when they're collapsed. */}
        {showReplies && <span className="tl-cline tl-stem" aria-hidden="true" />}

        {/* The face is a bead on the line, as a post's is on the feed's spine.
            This link is decorative (tabIndex -1 + aria-hidden): the author's
            name beside it is the single accessible link to the same profile,
            matching PostCard and avoiding two identical adjacent links. */}
        <Link
          to={`/u/${comment.author.id}`}
          className="tl-comment-bead"
          tabIndex={-1}
          aria-hidden="true"
        >
          <Avatar user={comment.author} size="xs" />
        </Link>

        <div className="tl-comment-body">
          <div
            className={
              isHighlighted
                ? "-mx-2 rounded-xl bg-accent-tint px-2 py-1 ring-2 ring-accent transition"
                : ""
            }
          >
            {/* `leading-6` is an explicit line box of exactly the face's height,
                so the name's centre lands on the face's centre with no nudging. */}
            <div className="flex min-w-0 items-center gap-2 leading-6">
              <Link
                to={`/u/${comment.author.id}`}
                className="min-w-0 truncate text-sm font-semibold text-ink hover:text-accent-deep"
              >
                {comment.author.display_name}
              </Link>
              <time
                className="shrink-0 font-mono text-xs text-ink-faint"
                dateTime={comment.created_at}
                title={formatAbsoluteTime(comment.created_at)}
              >
                {formatRelativeTime(comment.created_at)}
              </time>
              {/* The same transparency floor posts carry: quietly marked, with
                  the exact time on hover/focus. Silently altering something
                  others have already read is the trust problem this exists to
                  close, so it isn't optional. */}
              {comment.edited_at && !isDeleted && (
                <span
                  className="shrink-0 cursor-default text-xs text-ink-faint"
                  title={`Edited ${formatAbsoluteTime(comment.edited_at)}`}
                  aria-label={`Edited ${formatAbsoluteTime(comment.edited_at)}`}
                >
                  · edited
                </span>
              )}
            </div>

            {isDeleted ? (
              <p className="mt-1 text-[0.95rem] italic leading-relaxed text-ink-faint">
                Comment deleted
              </p>
            ) : editing ? (
              <CommentEditor
                commentId={comment.id}
                target={target}
                initialText={comment.text}
                onDone={() => setEditing(false)}
              />
            ) : (
              <p className="mt-1 whitespace-pre-wrap break-words text-[0.95rem] leading-relaxed text-ink">
                {comment.text}
              </p>
            )}

            <div className="mt-1.5 flex items-center gap-4 text-sm font-medium text-ink-faint">
              {!isDeleted && (
                <button
                  type="button"
                  onClick={() => {
                    setShowReply((v) => !v);
                    // Engaging with a sub-thread should show it (for context, and
                    // so the reply you're about to add is visible).
                    setCollapsed(false);
                    // See Edit below: one write box per comment.
                    setEditing(false);
                  }}
                  className="transition hover:text-accent-deep"
                >
                  Reply
                </button>
              )}
              {/* Everything that isn't Reply lives behind the ⋯, exactly as it
                  does on a post header and in the app: your own comment offers
                  Edit and Delete, someone else's offers Report. Keeping Report
                  inline while its two counterparts sat in a menu made the same
                  control look like two different kinds of thing depending on
                  whose comment you were looking at. */}
              {!isDeleted && user != null && (
                <OverflowMenu label="Comment options" compact>
                  {(close) =>
                    isOwner ? (
                      <>
                        <MenuItem
                          onClick={() => {
                            close();
                            setEditing(true);
                            // One write box per comment. Editing and replying
                            // both put a textarea on the same node, and two open
                            // at once is a muddle about which one Cancel belongs
                            // to — worse on the phone, where hardware back would
                            // close whichever happened to be opened last.
                            setShowReply(false);
                          }}
                        >
                          Edit
                        </MenuItem>
                        <MenuItem
                          danger
                          onClick={() => {
                            close();
                            setConfirmingDelete(true);
                          }}
                        >
                          Delete
                        </MenuItem>
                      </>
                    ) : (
                      <MenuItem
                        onClick={() => {
                          close();
                          setReporting(true);
                        }}
                      >
                        Report
                      </MenuItem>
                    )
                  }
                </OverflowMenu>
              )}
              {/* Kept even on a tombstone — the replies underneath are the only
                  reason it's still here, so hiding the way into them would
                  strand them. */}
              {replies.length > 0 && (
                <button
                  type="button"
                  onClick={() => setCollapsed((v) => !v)}
                  aria-expanded={!collapsed}
                  className="inline-flex items-center gap-1.5 font-semibold text-accent-deep transition hover:underline"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.75"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    className={`h-4 w-4 transition-transform ${
                      collapsed ? "" : "rotate-90"
                    }`}
                  >
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                  {collapsed
                    ? `Show ${replies.length} ${replies.length === 1 ? "reply" : "replies"}`
                    : "Hide replies"}
                </button>
              )}
            </div>

            {!isDeleted && (
              <ReactionBar
                commentId={comment.id}
                reactions={comment.reactions}
              />
            )}

            {showReply && !isDeleted && (
              <div className="mt-2">
                <CommentComposer
                  target={target}
                  parentId={comment.id}
                  autoFocus
                  placeholder={`Reply to ${comment.author.display_name}…`}
                  onDone={() => setShowReply(false)}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {reporting && (
        <ReportModal
          commentId={comment.id}
          onClose={() => setReporting(false)}
        />
      )}

      {confirmingDelete && (
        <ConfirmDeleteDialog
          title="Delete this comment?"
          // What actually happens depends on whether anything is hanging off it,
          // so say which. The count here is the replies *you* can see, which is
          // the honest thing to promise: a reply you can't see keeps the
          // tombstone alive server-side, but from where you're standing the
          // comment does simply go.
          description={
            replies.length > 0
              ? "This can’t be undone. The replies underneath will stay, with a note where your comment was."
              : "This can’t be undone."
          }
          label="Delete comment"
          errorFallback="Couldn’t delete the comment."
          // Held busy through success as well: the thread hasn't refetched yet,
          // and a second click would re-fire the delete.
          pending={deleteMutation.isPending || deleteMutation.isSuccess}
          error={deleteMutation.isError ? deleteMutation.error : null}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => deleteMutation.mutate()}
        />
      )}

      {/* The replies hang off our line by their own elbows, each of which
          carries the run on to the sibling below it. **No indent and no top
          padding here**: the step right is each reply's own left padding (which
          keeps its elbow inside its own box), and our stem ends exactly where
          the first elbow starts — anything between them is a break in the line.
          The air above comes from our own body's bottom padding. */}
      {showReplies && (
        <ul className="tl-comment-list">
          {replies.map((reply, index) => (
            <CommentNode
              key={reply.id}
              comment={reply}
              target={target}
              expandIds={expandIds}
              highlightId={highlightId}
              depth={depth + 1}
              isLast={index === replies.length - 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// Edit your own comment in place (issue #128) — the card-flips-into-an-editor
// pattern a post uses on the web, one level down. The thread is a plain list, so
// there's no virtualisation to unmount a half-typed edit and no reason to reach
// for the modal the phone needs.
function CommentEditor({ commentId, target, initialText, onDone }) {
  const [text, setText] = useState(initialText);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (value) => api.updateComment(commentId, value),
    onSuccess: () => {
      // Only the thread changes: an edit can't move a comment count, so the
      // post lists are left alone (unlike delete).
      queryClient.invalidateQueries({ queryKey: commentsQueryKey(target) });
      onDone();
    },
  });

  const trimmed = text.trim();
  // Emptying a comment is a delete, and delete is its own button — the server
  // says the same, so the disabled state means the button can never 400.
  const canSave = !mutation.isPending && trimmed.length > 0;

  function handleSubmit(event) {
    event.preventDefault();
    if (!canSave) return;
    mutation.mutate(trimmed);
  }

  return (
    <form onSubmit={handleSubmit} className="mt-1">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        autoFocus
        aria-label="Edit comment text"
        className="w-full resize-none rounded-xl border border-line-strong bg-raised px-3 py-2 text-sm text-ink transition placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-tint"
      />
      {mutation.isError && (
        <p role="alert" className="text-xs text-red-600">
          {serverMessage(mutation.error, "Couldn’t save. Try again.")}
        </p>
      )}
      <div className="mt-1.5 flex justify-end gap-2">
        {/* Held while the PATCH is out: `onDone` puts the comment back in read
            mode, which unmounts the only thing rendering the rejection above
            (#259). Gated on `isPending` rather than `canSave`, which is also
            false for an empty box — that would be a Cancel you couldn't press
            after clearing the text. */}
        <button
          type="button"
          onClick={onDone}
          disabled={mutation.isPending}
          className="rounded-lg px-3 py-1 text-xs font-semibold text-ink-faint transition hover:bg-accent-tint hover:text-accent-deep disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canSave}
          className="btn btn-primary btn-sm text-xs"
        >
          {mutation.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

// The write box for a comment or a reply. `parentId` null = top-level comment;
// otherwise it's a reply to that comment. On success it invalidates the post's
// comment tree so the new node appears in place — and the post lists with it,
// since the card's "Comments · N" moved too.
function CommentComposer({
  target,
  parentId = null,
  autoFocus = false,
  placeholder = "Write a comment…",
  onDone,
}) {
  const [text, setText] = useState("");
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (value) =>
      api.addComment(target, { text: value, parent: parentId }),
    onSuccess: () => {
      setText("");
      // The tree *and* the post's comment_count wherever it's shown — a new
      // comment moves both, the same way a delete does.
      invalidateComments(queryClient, target);
      onDone?.();
    },
  });

  function handleSubmit(event) {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    mutation.mutate(trimmed);
  }

  return (
    <form onSubmit={handleSubmit}>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        autoFocus={autoFocus}
        placeholder={placeholder}
        className="w-full resize-none rounded-xl border border-line-strong bg-raised px-3 py-2 text-sm text-ink transition placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-tint"
      />
      {mutation.isError && (
        <p className="text-xs text-red-600">
          {serverMessage(mutation.error, "Couldn't post. Try again.")}
        </p>
      )}
      <div className="mt-1.5 flex justify-end gap-2">
        {onDone && (
          <button
            type="button"
            onClick={onDone}
            disabled={mutation.isPending}
            className="rounded-lg px-3 py-1 text-xs font-semibold text-ink-faint transition hover:bg-accent-tint hover:text-accent-deep disabled:opacity-50"
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={!text.trim() || mutation.isPending}
          className="btn btn-primary btn-sm text-xs"
        >
          {mutation.isPending ? "Posting…" : parentId ? "Reply" : "Comment"}
        </button>
      </div>
    </form>
  );
}
