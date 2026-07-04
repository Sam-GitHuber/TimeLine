import { Link } from "react-router-dom";
import Avatar from "./Avatar.jsx";
import { getUserById } from "../mockData.js";
import { formatRelativeTime, formatAbsoluteTime } from "../utils.js";

// A single post in a feed: author, timestamp, and text.
export default function PostCard({ post }) {
  const author = getUserById(post.authorId);

  // Defensive: if a post ever references a missing author, don't crash the feed.
  if (!author) return null;

  return (
    <article className="border-b border-slate-200 px-4 py-4 sm:px-6">
      <div className="flex gap-3">
        {/* The avatar is a convenience click target to the same profile as the
            name link below. It's hidden from assistive tech and the tab order
            (aria-hidden + tabIndex=-1) so screen-reader/keyboard users get one
            named link per post, not an empty duplicate. */}
        <Link to={`/u/${author.username}`} tabIndex={-1} aria-hidden="true">
          <Avatar user={author} size="md" />
        </Link>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <Link
              to={`/u/${author.username}`}
              className="font-semibold text-slate-900 hover:underline"
            >
              {author.displayName}
            </Link>
            <span className="text-sm text-slate-500">@{author.username}</span>
            <span className="text-sm text-slate-400">·</span>
            <time
              className="text-sm text-slate-500"
              dateTime={post.createdAt}
              title={formatAbsoluteTime(post.createdAt)}
            >
              {formatRelativeTime(post.createdAt)}
            </time>
          </div>

          <p className="mt-1 whitespace-pre-wrap break-words text-slate-800">
            {post.text}
          </p>
        </div>
      </div>
    </article>
  );
}
