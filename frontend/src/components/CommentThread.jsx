import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Avatar from "./Avatar.jsx";
import ConfirmDeleteDialog from "./ConfirmDeleteDialog.jsx";
import ReactionBar from "./ReactionBar.jsx";
import ReportButton from "./ReportButton.jsx";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
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
// `highlightCommentId` (from the /p/:id permalink's ?comment=) deep-links to one
// comment: its ancestors are auto-expanded, it's scrolled into view, and it
// pulses briefly so the eye lands on it — the point of a "someone replied" link.
export default function CommentThread({ postId, highlightCommentId = null }) {
  const { data: comments, isLoading, isError, error } = useQuery({
    queryKey: ["comments", postId],
    queryFn: () => api.getComments(postId),
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

  return (
    <div className="tl-thread">
      {isLoading && (
        <p className="tl-thread-foot text-sm text-ink-faint">
          Loading comments…
        </p>
      )}

      {isError && (
        <p className="tl-thread-foot text-sm text-red-600">
          {error?.message || "Couldn't load comments."}
        </p>
      )}

      {!isLoading && !isError && (
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
                  postId={postId}
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
            <CommentComposer postId={postId} placeholder="Write a comment…" />
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
// Your own comment carries **Edit** and **Delete** (issue #128) — inline in the
// actions row, not behind a ⋯ menu. That's the split posts settled on: a post's
// controls moved into a menu because its header is crowded and its actions are
// heavier, while a comment's row is already the home of Reply and Report, and a
// menu on every node of a deep tree would be more chrome than thread. Edit sits
// before Delete so the pointer heading for the safe action never crosses the
// destructive one, the same ordering as `PostMenu`.
//
// A **deleted** comment arrives as a tombstone: blank text with `deleted_at`
// set, kept only because replies hang off it. It renders as a quiet placeholder
// and offers nothing — no reply, no report, no reactions — except the toggle
// that opens the replies it exists to hold up.
function CommentNode({
  comment,
  postId,
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
      // as deleting a post does.
      queryClient.invalidateQueries({ queryKey: ["comments", postId] });
      queryClient.invalidateQueries({ queryKey: ["feed"] });
      queryClient.invalidateQueries({ queryKey: ["userPosts"] });
      queryClient.invalidateQueries({ queryKey: ["groupPosts"] });
      queryClient.invalidateQueries({ queryKey: ["post", String(postId)] });
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
                postId={postId}
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
              {!isDeleted && (
                <ReportButton
                  commentId={comment.id}
                  authorId={comment.author.id}
                />
              )}
              {isOwner && !editing && (
                <button
                  type="button"
                  onClick={() => {
                    setEditing(true);
                    // One write box per comment. Editing and replying both put
                    // a textarea on the same node, and two open at once is a
                    // muddle about which one Cancel belongs to — worse on the
                    // phone, where hardware back would close whichever happened
                    // to be opened last.
                    setShowReply(false);
                  }}
                  className="transition hover:text-accent-deep"
                >
                  Edit
                </button>
              )}
              {isOwner && (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  className="text-red-600 transition hover:text-red-700"
                >
                  Delete
                </button>
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
                  postId={postId}
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
              postId={postId}
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
function CommentEditor({ commentId, postId, initialText, onDone }) {
  const [text, setText] = useState(initialText);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (value) => api.updateComment(commentId, value),
    onSuccess: () => {
      // Only the thread changes: an edit can't move a comment count, so the
      // post lists are left alone (unlike delete).
      queryClient.invalidateQueries({ queryKey: ["comments", postId] });
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
          {mutation.error?.message || "Couldn’t save. Try again."}
        </p>
      )}
      <div className="mt-1.5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onDone}
          className="rounded-lg px-3 py-1 text-xs font-semibold text-ink-faint transition hover:bg-accent-tint hover:text-accent-deep"
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
// comment tree so the new node appears in place.
function CommentComposer({
  postId,
  parentId = null,
  autoFocus = false,
  placeholder = "Write a comment…",
  onDone,
}) {
  const [text, setText] = useState("");
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (value) =>
      api.addComment(postId, { text: value, parent: parentId }),
    onSuccess: () => {
      setText("");
      queryClient.invalidateQueries({ queryKey: ["comments", postId] });
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
          {mutation.error?.message || "Couldn't post. Try again."}
        </p>
      )}
      <div className="mt-1.5 flex justify-end gap-2">
        {onDone && (
          <button
            type="button"
            onClick={onDone}
            className="rounded-lg px-3 py-1 text-xs font-semibold text-ink-faint transition hover:bg-accent-tint hover:text-accent-deep"
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
