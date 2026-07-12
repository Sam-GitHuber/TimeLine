import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Avatar from "./Avatar.jsx";
import ReactionBar from "./ReactionBar.jsx";
import ReportButton from "./ReportButton.jsx";
import { api } from "../api.js";
import { formatRelativeTime, formatAbsoluteTime } from "../utils.js";

// The comment tree for one post, as a collapsible accordion.
//
// The backend returns an already-pruned nested tree: you only ever receive
// comments (and replies) from people you're connected with — a not-connected
// author's comment and everything under it is dropped server-side, so there is
// no hidden content here to leak (issue #12). The frontend just renders what it
// gets, nesting `replies` under each comment.
export default function CommentThread({ postId }) {
  const { data: comments, isLoading, isError, error } = useQuery({
    queryKey: ["comments", postId],
    queryFn: () => api.getComments(postId),
  });

  return (
    <div className="mt-4 rounded-2xl border border-line bg-raised p-4">
      {isLoading && <p className="text-sm text-ink-faint">Loading comments…</p>}

      {isError && (
        <p className="text-sm text-red-600">
          {error?.message || "Couldn't load comments."}
        </p>
      )}

      {!isLoading && !isError && (
        <>
          {comments.length === 0 ? (
            <p className="text-sm text-ink-faint">
              No comments yet. Start the conversation.
            </p>
          ) : (
            <ul className="space-y-4">
              {comments.map((comment) => (
                <CommentNode
                  key={comment.id}
                  comment={comment}
                  postId={postId}
                />
              ))}
            </ul>
          )}

          {/* Top-level composer (a comment on the post itself). */}
          <div className="mt-4">
            <CommentComposer postId={postId} placeholder="Write a comment…" />
          </div>
        </>
      )}
    </div>
  );
}

// One comment plus its replies, indented under it. Replies start *collapsed*, so
// a busy post opens as a clean list of top-level comments and you drill into
// just the sub-thread you want — much easier to follow a long thread (and less
// overwhelming) than a wall of nested replies. Opening the reply box, or having
// posted a reply, reveals the sub-thread so you always see your own reply.
function CommentNode({ comment, postId }) {
  const replies = comment.replies ?? [];
  const [showReply, setShowReply] = useState(false);
  const [collapsed, setCollapsed] = useState(replies.length > 0);

  return (
    <li className="flex gap-2.5">
      <Link to={`/u/${comment.author.id}`} tabIndex={-1} aria-hidden="true">
        <Avatar user={comment.author} size="sm" />
      </Link>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-x-2">
          <Link
            to={`/u/${comment.author.id}`}
            className="text-sm font-semibold text-ink hover:text-accent-deep"
          >
            {comment.author.display_name}
          </Link>
          <time
            className="font-mono text-xs text-ink-faint"
            dateTime={comment.created_at}
            title={formatAbsoluteTime(comment.created_at)}
          >
            {formatRelativeTime(comment.created_at)}
          </time>
        </div>

        <p className="whitespace-pre-wrap break-words text-[0.95rem] leading-relaxed text-ink">
          {comment.text}
        </p>

        <div className="mt-1.5 flex items-center gap-4 text-sm font-medium text-ink-faint">
          <button
            type="button"
            onClick={() => {
              setShowReply((v) => !v);
              // Engaging with a sub-thread should show it (for context, and so
              // the reply you're about to add is visible).
              setCollapsed(false);
            }}
            className="transition hover:text-accent-deep"
          >
            Reply
          </button>
          <ReportButton commentId={comment.id} authorId={comment.author.id} />
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

        <ReactionBar commentId={comment.id} reactions={comment.reactions} />

        {showReply && (
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

        {/* Replies nest under a left rule, so depth reads at a glance. */}
        {replies.length > 0 && !collapsed && (
          <ul className="mt-3 space-y-4 border-l-2 border-line pl-3">
            {replies.map((reply) => (
              <CommentNode key={reply.id} comment={reply} postId={postId} />
            ))}
          </ul>
        )}
      </div>
    </li>
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
        className="w-full resize-none rounded-xl border border-line-strong bg-surface px-3 py-2 text-sm text-ink transition placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-tint"
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
