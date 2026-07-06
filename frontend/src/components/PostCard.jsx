import { useState } from "react";
import { Link } from "react-router-dom";
import CommentThread from "./CommentThread.jsx";
import Lightbox from "./Lightbox.jsx";
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
  // Which photo the lightbox is showing; null = closed.
  const [lightboxIndex, setLightboxIndex] = useState(null);

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
        <div className="mb-1.5">
          <Link
            to={`/u/${author.id}`}
            className="font-semibold text-ink transition hover:text-accent-deep"
          >
            {author.display_name}
          </Link>
        </div>

        {post.text && (
          <p className="whitespace-pre-wrap break-words text-[1.02rem] leading-relaxed text-ink">
            {post.text}
          </p>
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
