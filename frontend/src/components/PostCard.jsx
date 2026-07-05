import { useState } from "react";
import { Link } from "react-router-dom";
import CommentThread from "./CommentThread.jsx";
import { formatClockTime, formatAbsoluteTime } from "../utils.js";

// A single post as an entry on the timeline: a node on the line, its clock time
// on the rail, then the author, text, and a collapsible comment thread. The
// author comes embedded in the post from the API ({ id, display_name }), and
// posts are identified by numeric user id in profile links (there is no
// username).
export default function PostCard({ post }) {
  const author = post.author;
  // Comments load lazily: we only fetch a post's thread once you open it, so
  // scrolling the feed doesn't fire a request per post.
  const [showComments, setShowComments] = useState(false);

  // Defensive: if a post ever arrives without an author, don't crash the feed.
  if (!author) return null;

  const { time, meridiem } = formatClockTime(post.created_at);

  return (
    <article className="tl-entry">
      <div className="tl-rail">
        <span className="tl-node" aria-hidden="true" />
        <time
          className="font-mono text-xs tabular-nums text-ink-faint"
          dateTime={post.created_at}
          title={formatAbsoluteTime(post.created_at)}
        >
          {time}
          <br />
          {meridiem}
        </time>
      </div>

      <div className="tl-body">
        <div className="mb-1.5">
          <Link
            to={`/u/${author.id}`}
            className="font-semibold text-ink transition hover:text-accent-deep"
          >
            {author.display_name}
          </Link>
        </div>

        <p className="whitespace-pre-wrap break-words text-[1.02rem] leading-relaxed text-ink">
          {post.text}
        </p>

        <div className="mt-3 -ml-2">
          <button
            type="button"
            onClick={() => setShowComments((v) => !v)}
            aria-expanded={showComments}
            className="rounded-lg px-2 py-1 text-sm font-medium text-ink-faint transition hover:bg-accent-tint hover:text-accent-deep"
          >
            {showComments ? "Hide comments" : "Comments"}
          </button>
        </div>

        {showComments && <CommentThread postId={post.id} />}
      </div>
    </article>
  );
}
