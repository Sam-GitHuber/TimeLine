import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import CommentThread from "./CommentThread.jsx";
import Lightbox from "./Lightbox.jsx";
import ReactionBar from "./ReactionBar.jsx";
import PostMenu from "./PostMenu.jsx";
import { api } from "../api.js";
import { markPostCommentsSeen } from "../postCache.js";
import { formatClockTime, formatAbsoluteTime } from "../utils.js";

// A single post as an entry on the timeline: a node on the line, its clock time
// on the rail, then the author, text, and a collapsible comment thread. The
// author comes embedded in the post from the API ({ id, display_name }), and
// posts are identified by numeric user id in profile links (there is no
// username).
// `defaultCommentsOpen` + `highlightCommentId` are used by the /p/:id permalink
// page: it opens with the thread already expanded and deep-links to a specific
// comment (see CommentThread). In the feed both are omitted, so nothing changes.
export default function PostCard({
  post,
  defaultCommentsOpen = false,
  highlightCommentId = null,
}) {
  const author = post.author;
  // Comments load lazily: we only fetch a post's thread once you open it, so
  // scrolling the feed doesn't fire a request per post. On a permalink we start
  // open so the deep-linked comment is reachable without a click.
  const [showComments, setShowComments] = useState(defaultCommentsOpen);
  // Which photo the lightbox is showing; null = closed.
  const [lightboxIndex, setLightboxIndex] = useState(null);
  // Whether the post text is flipped into its inline editor (issue #62).
  const [editing, setEditing] = useState(false);
  const queryClient = useQueryClient();

  // Opening the thread marks its comments seen server-side (the GET), so mirror
  // that into the cached feed/profile/group/permalink data straight away — the
  // "N new" badge then follows the (fresh, server-shaped) count and clears,
  // instead of waiting for the next refetch. A permalink opens already-expanded,
  // so mark it on mount too.
  const openComments = () => markPostCommentsSeen(queryClient, post.id);
  useEffect(() => {
    if (defaultCommentsOpen) openComments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultCommentsOpen, post.id]);

  // Defensive: if a post ever arrives without an author, don't crash the feed.
  if (!author) return null;

  const { time, meridiem } = formatClockTime(post.created_at);

  const commentCount = post.comment_count ?? 0;
  const newCount = post.new_comment_count ?? 0;
  // Driven purely by the server-shaped count (kept fresh via markPostCommentsSeen
  // on open), so genuinely-new comments re-badge later. Hidden while the thread
  // is open — you're already looking at them.
  const showNew = newCount > 0 && !showComments;

  return (
    <article className="tl-entry">
      <div className="tl-rail">
        <span className="tl-node" aria-hidden="true" />
        <time
          className="font-mono text-xs tabular-nums text-ink-faint"
          dateTime={post.created_at}
          title={formatAbsoluteTime(post.created_at)}
          // The visible text splits over two lines ("2:10" / "pm"); give
          // assistive tech the full, unambiguous timestamp instead of "2:10pm".
          aria-label={formatAbsoluteTime(post.created_at)}
        >
          {time}
          <br />
          {meridiem}
        </time>
      </div>

      <div className="tl-body">
        <div className="mb-1.5 flex items-start justify-between gap-2">
          <div className="flex flex-wrap items-baseline gap-x-1.5">
            <Link
              to={`/u/${author.id}`}
              className="font-semibold text-ink transition hover:text-accent-deep"
            >
              {author.display_name}
            </Link>
            {/* When a group post surfaces in the merged feed, label which group
                it came from so the stream doesn't feel context-less. Omitted on
                a group's own timeline is fine — the label just links back to it. */}
            {post.group && (
              <span className="text-sm text-ink-faint">
                in{" "}
                <Link
                  to={`/g/${post.group.id}`}
                  className="font-medium text-accent-deep hover:underline"
                >
                  {post.group.name}
                </Link>
              </span>
            )}
            {/* Quiet "edited" marker: only on a post that really was edited
                (edited_at is null until the first edit), with the exact edit
                time on hover/focus — the same title/aria-label pattern the
                created-at timestamp uses. Silently altering content others have
                read would be a trust problem, so the marker isn't optional. */}
            {post.edited_at && (
              <span
                className="cursor-default text-sm text-ink-faint"
                title={`Edited ${formatAbsoluteTime(post.edited_at)}`}
                aria-label={`Edited ${formatAbsoluteTime(post.edited_at)}`}
              >
                · edited
              </span>
            )}
          </div>

          {/* The ⋯ overflow menu: Edit/Delete for the owner, Report otherwise. */}
          <PostMenu
            postId={post.id}
            authorId={author.id}
            onEdit={() => setEditing(true)}
          />
        </div>

        {editing ? (
          <PostEditor
            postId={post.id}
            initialText={post.text}
            hasImages={post.images?.length > 0}
            onDone={() => setEditing(false)}
          />
        ) : (
          post.text && (
            <p className="whitespace-pre-wrap break-words text-[1.02rem] leading-relaxed text-ink">
              {post.text}
            </p>
          )
        )}

        {post.images?.length > 0 && (
          <div
            className={`mt-2.5 grid gap-1.5 ${
              post.images.length === 1 ? "grid-cols-1" : "grid-cols-2"
            }`}
          >
            {post.images.map((image, i) => (
              <button
                key={image.id}
                type="button"
                onClick={() => setLightboxIndex(i)}
                aria-label={`View photo ${i + 1} of ${post.images.length}`}
                className="block cursor-pointer overflow-hidden rounded-xl border border-line"
              >
                <img
                  src={image.thumbnail}
                  width={image.width}
                  height={image.height}
                  loading="lazy"
                  alt=""
                  // One photo keeps its natural shape (capped height); several
                  // share a uniform square grid so the layout stays tidy.
                  className={
                    post.images.length === 1
                      ? "max-h-[28rem] w-full object-cover transition hover:opacity-95"
                      : "aspect-square w-full object-cover transition hover:opacity-95"
                  }
                />
              </button>
            ))}
          </div>
        )}

        {lightboxIndex !== null && (
          <Lightbox
            images={post.images}
            index={lightboxIndex}
            onClose={() => setLightboxIndex(null)}
            onIndexChange={setLightboxIndex}
          />
        )}

        <ReactionBar postId={post.id} reactions={post.reactions} />

        <div className="mt-3 -ml-2 flex items-center gap-3">
          <button
            type="button"
            onClick={() => {
              if (!showComments) openComments();
              setShowComments((v) => !v);
            }}
            aria-expanded={showComments}
            className="rounded-lg px-2 py-1 text-sm font-medium text-ink-faint transition hover:bg-accent-tint hover:text-accent-deep"
          >
            {showComments ? "Hide comments" : "Comments"}
            {/* Total visible comments (issue #63) — matches what actually expands,
                since the count is pruned server-side to your connections. Hidden
                when zero so an empty thread just reads "Comments". */}
            {commentCount > 0 && (
              <span className="ml-1.5 tabular-nums">· {commentCount}</span>
            )}
            {/* New (unseen) comments, in the accent colour so they stand out.
                Only before you've opened the thread — opening it marks them seen. */}
            {showNew && (
              <span className="ml-1.5 font-semibold tabular-nums text-accent-deep">
                · {newCount} new
              </span>
            )}
          </button>
          {/* Report has moved into the ⋯ menu in the header (issue #62), so it's
              no longer here in the footer. */}
        </div>

        {showComments && (
          <CommentThread
            // Remount when the deep-link target changes so the highlight re-arms.
            key={highlightCommentId ?? "thread"}
            postId={post.id}
            highlightCommentId={highlightCommentId}
          />
        )}
      </div>
    </article>
  );
}

// The inline editor a post's text flips into when the owner picks "Edit" from
// the ⋯ menu — an in-place textarea + Save/Cancel, mirroring the comment
// composer rather than a separate edit page. On save it PATCHes the post and
// invalidates every list the post can appear in so the new text (and the
// "edited" marker) show up wherever it's rendered. Text-only in v1 — photos
// aren't editable here.
function PostEditor({ postId, initialText, hasImages = false, onDone }) {
  const [text, setText] = useState(initialText ?? "");
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (value) => api.updatePost(postId, value),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["feed"] });
      queryClient.invalidateQueries({ queryKey: ["userPosts"] });
      queryClient.invalidateQueries({ queryKey: ["groupPosts"] });
      queryClient.invalidateQueries({ queryKey: ["post", String(postId)] });
      onDone();
    },
  });

  // A photo-only post may keep blank text, but a text-only post can't be
  // emptied to nothing — matching the backend's guard.
  const trimmed = text.trim();
  const canSave = !mutation.isPending && (trimmed.length > 0 || hasImages);

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
        rows={3}
        autoFocus
        aria-label="Edit post text"
        className="w-full resize-none rounded-xl border border-line-strong bg-surface px-3 py-2 text-[1.02rem] leading-relaxed text-ink transition placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-tint"
      />
      {mutation.isError && (
        <p role="alert" className="mt-1 text-sm text-red-600">
          {mutation.error?.message || "Couldn’t save your changes."}
        </p>
      )}
      <div className="mt-1.5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onDone}
          className="rounded-lg px-3 py-1 text-sm font-semibold text-ink-faint transition hover:bg-accent-tint hover:text-accent-deep"
        >
          Cancel
        </button>
        <button type="submit" disabled={!canSave} className="btn btn-primary btn-sm">
          {mutation.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}
