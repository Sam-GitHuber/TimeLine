import ComposeBox from "../components/ComposeBox.jsx";
import Timeline from "../components/Timeline.jsx";
import LoadMoreButton from "../components/LoadMoreButton.jsx";
import { useInfiniteList } from "../hooks.js";
import { api } from "../api.js";

// The home timeline: your posts + everyone you're connected with, strictly
// newest-first. No ranking, no "suggested" content — that constraint is the
// whole point of the project. The backend already orders and scopes the feed;
// the frontend just renders the pages, following the `next` URL to load older
// posts.
export default function FeedPage() {
  const feed = useInfiniteList(["feed"], api.getFeed);
  const { items: posts, isLoading, isError, error } = feed;

  return (
    <div>
      <Timeline posts={posts} header={<ComposeBox />} />

      {isLoading && (
        <p className="px-6 py-10 text-center text-ink-faint">Loading feed…</p>
      )}

      {isError && (
        <p className="px-6 py-10 text-center text-red-600">
          {error?.message || "Couldn't load the feed."}
        </p>
      )}

      {!isLoading && !isError && posts.length === 0 && (
        <p className="px-6 py-10 text-center text-ink-faint">
          Your feed is empty. Write something above, or find people to connect
          with.
        </p>
      )}

      <LoadMoreButton query={feed} />
    </div>
  );
}
