import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
    <div className="mt-3 border-t border-slate-100 pt-3">
      {isLoading && <p className="text-sm text-slate-500">Loading comments…</p>}

      {isError && (
        <p className="text-sm text-rose-600">
          {error?.message || "Couldn't load comments."}
        </p>
      )}

      {!isLoading && !isError && (
        <>
          {comments.length === 0 ? (
            <p className="text-sm text-slate-500">
              No comments yet. Start the conversation.
            </p>
          ) : (
            <ul className="space-y-3">
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
          <div className="mt-3">
            <CommentComposer postId={postId} placeholder="Write a comment…" />
          </div>
        </>
      )}
    </div>
  );
}

// One comment plus its (visible) replies, indented under it. Each node with
// replies can be collapsed — the accordion behaviour from issue #12.
function CommentNode({ comment, postId }) {
  const [showReply, setShowReply] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const replies = comment.replies ?? [];

  return (
    <li>
      <div className="flex items-baseline gap-x-2">
        <Link
          to={`/u/${comment.author.id}`}
          className="text-sm font-semibold text-slate-900 hover:underline"
        >
          {comment.author.display_name}
        </Link>
        <span className="text-xs text-slate-400">·</span>
        <time
          className="text-xs text-slate-500"
          dateTime={comment.created_at}
          title={formatAbsoluteTime(comment.created_at)}
        >
          {formatRelativeTime(comment.created_at)}
        </time>
      </div>

      <p className="whitespace-pre-wrap break-words text-sm text-slate-800">
        {comment.text}
      </p>

      <div className="mt-1 flex gap-3 text-xs font-medium text-slate-500">
        <button
          type="button"
          onClick={() => setShowReply((v) => !v)}
          className="hover:text-slate-800"
        >
          Reply
        </button>
        {replies.length > 0 && (
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className="hover:text-slate-800"
          >
            {collapsed
              ? `Show ${replies.length} ${replies.length === 1 ? "reply" : "replies"}`
              : "Hide replies"}
          </button>
        )}
      </div>

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
        <ul className="mt-3 space-y-3 border-l-2 border-slate-100 pl-3">
          {replies.map((reply) => (
            <CommentNode key={reply.id} comment={reply} postId={postId} />
          ))}
        </ul>
      )}
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
        className="w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-slate-300 focus:outline-none"
      />
      {mutation.isError && (
        <p className="text-xs text-rose-600">
          {mutation.error?.message || "Couldn't post. Try again."}
        </p>
      )}
      <div className="mt-1 flex justify-end gap-2">
        {onDone && (
          <button
            type="button"
            onClick={onDone}
            className="rounded-full px-3 py-1 text-xs font-semibold text-slate-500 transition hover:bg-slate-100"
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={!text.trim() || mutation.isPending}
          className="rounded-full bg-sky-600 px-4 py-1 text-xs font-semibold text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {mutation.isPending ? "Posting…" : parentId ? "Reply" : "Comment"}
        </button>
      </div>
    </form>
  );
}
