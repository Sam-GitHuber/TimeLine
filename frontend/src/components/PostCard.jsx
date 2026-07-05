import { useState } from "react";
import { Link } from "react-router-dom";
import Avatar from "./Avatar.jsx";
import CommentThread from "./CommentThread.jsx";
import { formatRelativeTime, formatAbsoluteTime } from "../utils.js";

// A single post in a feed: author, timestamp, text, and a collapsible comment
// thread. The author comes embedded in the post from the API
// ({ id, display_name }), and posts are identified by numeric user id in
// profile links (there is no username).
export default function PostCard({ post }) {
  const author = post.author;
  // Comments load lazily: we only fetch a post's thread once you open it, so
  // scrolling the feed doesn't fire a request per post.
  const [showComments, setShowComments] = useState(false);

  // Defensive: if a post ever arrives without an author, don't crash the feed.
  if (!author) return null;

  return (
    <article className="border-b border-slate-200 px-4 py-4 sm:px-6">
      <div className="flex gap-3">
        {/* The avatar is a convenience click target to the same profile as the
            name link below. It's hidden from assistive tech and the tab order
            (aria-hidden + tabIndex=-1) so screen-reader/keyboard users get one
            named link per post, not an empty duplicate. */}
        <Link to={`/u/${author.id}`} tabIndex={-1} aria-hidden="true">
          <Avatar user={author} size="md" />
        </Link>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <Link
              to={`/u/${author.id}`}
              className="font-semibold text-slate-900 hover:underline"
            >
              {author.display_name}
            </Link>
            <span className="text-sm text-slate-400">·</span>
            <time
              className="text-sm text-slate-500"
              dateTime={post.created_at}
              title={formatAbsoluteTime(post.created_at)}
            >
              {formatRelativeTime(post.created_at)}
            </time>
          </div>

          <p className="mt-1 whitespace-pre-wrap break-words text-slate-800">
            {post.text}
          </p>

          <button
            type="button"
            onClick={() => setShowComments((v) => !v)}
            aria-expanded={showComments}
            className="mt-2 text-sm font-medium text-slate-500 transition hover:text-slate-800"
          >
            {showComments ? "Hide comments" : "Comments"}
          </button>

          {showComments && <CommentThread postId={post.id} />}
        </div>
      </div>
    </article>
  );
}
