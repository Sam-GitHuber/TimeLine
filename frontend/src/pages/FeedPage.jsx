import { useState } from "react";
import ComposeBox from "../components/ComposeBox.jsx";
import Timeline from "../components/Timeline.jsx";
import LoadMoreButton from "../components/LoadMoreButton.jsx";
import { useInfiniteList } from "../hooks.js";
import { api } from "../api.js";

// Remember the "include groups" choice per browser so it survives reloads —
// it's a viewing preference, not something worth a round-trip to save.
const INCLUDE_GROUPS_KEY = "feed:includeGroups";

// The home timeline: your posts + everyone you're connected with, strictly
// newest-first. No ranking, no "suggested" content — that constraint is the
// whole point of the project. The backend already orders and scopes the feed;
// the frontend just renders the pages, following the `next` URL to load older
// posts.
//
// The "Include groups" toggle opts in to *also* merging posts from groups you're
// a member of into the same chronological stream (off by default, so the feed
// stays "my connections" unless you ask for more). It's still a pure time-merge
// — no algorithm — the backend just widens what it selects.
export default function FeedPage() {
  const [includeGroups, setIncludeGroups] = useState(
    () => localStorage.getItem(INCLUDE_GROUPS_KEY) === "1"
  );

  function toggleGroups() {
    setIncludeGroups((on) => {
      const next = !on;
      localStorage.setItem(INCLUDE_GROUPS_KEY, next ? "1" : "0");
      return next;
    });
  }

  // The flag is part of the query key so the two views cache separately and
  // switching refetches the right stream.
  const feed = useInfiniteList(["feed", { includeGroups }], () =>
    api.getFeed({ includeGroups })
  );
  const { items: posts, isLoading, isError, error } = feed;

  return (
    <div>
      <div className="flex items-center justify-end border-b border-line px-5 py-2.5">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-soft">
          <input
            type="checkbox"
            checked={includeGroups}
            onChange={toggleGroups}
            className="h-4 w-4 rounded border-line-strong text-accent focus:ring-accent-tint"
          />
          Include groups
        </label>
      </div>

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
