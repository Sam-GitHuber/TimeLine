import { Link, useParams } from "react-router-dom";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import Avatar from "../components/Avatar.jsx";
import FollowButton from "../components/FollowButton.jsx";
import PostCard from "../components/PostCard.jsx";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";

// A single person's page: their details plus their own posts, newest-first.
// Users are identified by numeric id in the URL (there is no username).
export default function ProfilePage() {
  const { id } = useParams();
  const userId = Number(id);
  const { user: me } = useAuth();
  const isSelf = me?.pk === userId;

  const userQuery = useQuery({
    queryKey: ["user", userId],
    queryFn: () => api.getUser(userId),
  });

  const postsQuery = useInfiniteQuery({
    queryKey: ["userPosts", userId],
    queryFn: ({ pageParam }) =>
      pageParam ? api.getPage(pageParam) : api.getUserPosts(userId),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
  });

  // A user id that doesn't exist (or an inactive account) → 404 from the API.
  if (userQuery.isError) {
    return (
      <div className="px-6 py-16 text-center">
        <p className="text-lg font-medium text-slate-800">User not found</p>
        <p className="mt-1 text-slate-500">No one here goes by that id.</p>
        <Link
          to="/"
          className="mt-4 inline-block font-medium text-sky-600 hover:underline"
        >
          ← Back to the feed
        </Link>
      </div>
    );
  }

  if (userQuery.isLoading) {
    return <p className="px-6 py-10 text-center text-slate-500">Loading…</p>;
  }

  const user = userQuery.data;
  const posts = postsQuery.data?.pages.flatMap((page) => page.results) ?? [];

  return (
    <div>
      <section className="border-b border-slate-200 px-4 py-6 sm:px-6">
        <div className="flex items-start gap-4">
          <Avatar user={user} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-4">
              <h1 className="text-2xl font-bold text-slate-900">
                {user.display_name}
              </h1>
              {/* Can't follow yourself; the button only shows for other people. */}
              {!isSelf && (
                <FollowButton
                  userId={user.id}
                  isFollowing={user.is_following}
                />
              )}
            </div>
            {/* Bio and other profile fields arrive in Phase 4. */}
          </div>
        </div>
      </section>

      <h2 className="px-4 py-3 text-sm font-semibold uppercase tracking-wide text-slate-400 sm:px-6">
        Posts
      </h2>

      {postsQuery.isLoading ? (
        <p className="px-6 py-10 text-center text-slate-500">Loading posts…</p>
      ) : posts.length > 0 ? (
        <>
          {posts.map((post) => (
            <PostCard key={post.id} post={post} />
          ))}
          {postsQuery.hasNextPage && (
            <div className="flex justify-center py-4">
              <button
                type="button"
                onClick={() => postsQuery.fetchNextPage()}
                disabled={postsQuery.isFetchingNextPage}
                className="rounded-full border border-slate-300 px-5 py-1.5 font-medium text-slate-700 transition hover:bg-slate-100 disabled:opacity-50"
              >
                {postsQuery.isFetchingNextPage ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </>
      ) : (
        <p className="px-6 py-10 text-center text-slate-500">
          {user.display_name} hasn’t posted yet.
        </p>
      )}
    </div>
  );
}
