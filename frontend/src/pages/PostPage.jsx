import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import PostCard from "../components/PostCard.jsx";
import { api } from "../api.js";

// A single post on its own page — the permalink (`/p/:id`). Notifications
// deep-link here so "someone replied to your post" opens the actual thread,
// with `?comment=<id>` scrolling to (and highlighting) the specific reply, even
// one buried deep. Fetching the post by id (not relying on it being loaded in
// some feed) is what makes the link reliable regardless of pagination.
//
// The thread opens expanded; visibility is enforced server-side (a post you
// can't see 404s), same as every other post surface.
export default function PostPage() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const commentParam = searchParams.get("comment");
  const highlightCommentId = commentParam ? Number(commentParam) : null;

  const {
    data: post,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ["post", id],
    queryFn: () => api.getPost(id),
    retry: false,
  });

  const notFound = isError && error?.status === 404;

  return (
    <div className="px-1 py-2">
      <div className="px-5 py-3">
        <Link
          to="/"
          className="text-sm font-medium text-ink-faint transition hover:text-accent-deep"
        >
          ← Back to feed
        </Link>
      </div>

      {isLoading && (
        <p className="px-6 py-10 text-center text-ink-faint">Loading post…</p>
      )}

      {notFound && (
        <p className="px-6 py-10 text-center text-ink-faint">
          This post doesn’t exist, or you don’t have access to it.
        </p>
      )}

      {isError && !notFound && (
        <p className="px-6 py-10 text-center text-red-600">
          {error?.message || "Couldn’t load this post."}
        </p>
      )}

      {post && (
        // The .tl-feed wrapper supplies the timeline spine PostCard's rail hangs
        // off, so a standalone post looks at home rather than orphaned.
        <div className="tl-feed">
          <PostCard
            post={post}
            defaultCommentsOpen
            highlightCommentId={highlightCommentId}
          />
        </div>
      )}
    </div>
  );
}
