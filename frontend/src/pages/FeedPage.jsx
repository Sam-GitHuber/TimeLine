import ComposeBox from "../components/ComposeBox.jsx";
import PostCard from "../components/PostCard.jsx";
import LoadMoreButton from "../components/LoadMoreButton.jsx";
import { useInfiniteList } from "../hooks.js";
import { api } from "../api.js";

// The home timeline: your posts + everyone you follow, strictly newest-first.
// No ranking, no "suggested" content — that constraint is the whole point of
// the project. The backend already orders and scopes the feed; the frontend
// just renders the pages, following the `next` URL to load older posts.
export default function FeedPage() {
  const feed = useInfiniteList(["feed"], api.getFeed);
  const { items: posts, isLoading, isError, error } = feed;

  return (
    <div>
      <ComposeBox />

      {isLoading && (
        <p className="px-6 py-10 text-center text-slate-500">Loading feed…</p>
      )}

      {isError && (
        <p className="px-6 py-10 text-center text-rose-600">
          {error?.message || "Couldn't load the feed."}
        </p>
      )}

      {!isLoading && !isError && posts.length === 0 && (
        <p className="px-6 py-10 text-center text-slate-500">
          Your feed is empty. Write something above, or find people to follow.
        </p>
      )}

      {posts.map((post) => (
        <PostCard key={post.id} post={post} />
      ))}

      <LoadMoreButton query={feed} />
    </div>
  );
}
