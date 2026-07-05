import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import Avatar from "../components/Avatar.jsx";
import ConnectButton from "../components/ConnectButton.jsx";
import PostCard from "../components/PostCard.jsx";
import LoadMoreButton from "../components/LoadMoreButton.jsx";
import { useInfiniteList } from "../hooks.js";
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

  const postsQuery = useInfiniteList(["userPosts", userId], () =>
    api.getUserPosts(userId)
  );

  // Only a real 404 means "no such user". A transient 5xx/network error must
  // not masquerade as that — show a retryable error instead of telling someone
  // a user who exists doesn't.
  if (userQuery.isError && userQuery.error?.status === 404) {
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

  if (userQuery.isError) {
    return (
      <div className="px-6 py-16 text-center">
        <p className="text-lg font-medium text-rose-600">
          {userQuery.error?.message || "Couldn't load this profile."}
        </p>
        <button
          type="button"
          onClick={() => userQuery.refetch()}
          className="mt-4 inline-block rounded-full border border-slate-300 px-5 py-1.5 font-medium text-slate-700 transition hover:bg-slate-100"
        >
          Try again
        </button>
      </div>
    );
  }

  if (userQuery.isLoading) {
    return <p className="px-6 py-10 text-center text-slate-500">Loading…</p>;
  }

  const user = userQuery.data;
  const posts = postsQuery.items;
  // Private-by-default: unless it's you or a connection, the backend returns no
  // posts, and we show a locked state explaining why.
  const canSeePosts = isSelf || user.connection_status === "connected";

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
              {/* Can't connect with yourself; the button only shows for
                  other people. */}
              {!isSelf && (
                <ConnectButton
                  userId={user.id}
                  connectionStatus={user.connection_status}
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

      {!canSeePosts ? (
        <div className="px-6 py-10 text-center text-slate-500">
          <p className="font-medium text-slate-700">
            {user.display_name}’s posts are private.
          </p>
          <p className="mt-1">
            {user.connection_status === "requested"
              ? "Your connection request is waiting for approval."
              : user.connection_status === "incoming"
                ? `${user.display_name} asked to connect — approve to see each other’s posts.`
                : "Connect, and once they approve you’ll see each other’s posts here."}
          </p>
        </div>
      ) : postsQuery.isLoading ? (
        <p className="px-6 py-10 text-center text-slate-500">Loading posts…</p>
      ) : posts.length > 0 ? (
        <>
          {posts.map((post) => (
            <PostCard key={post.id} post={post} />
          ))}
          <LoadMoreButton query={postsQuery} />
        </>
      ) : (
        <p className="px-6 py-10 text-center text-slate-500">
          {user.display_name} hasn’t posted yet.
        </p>
      )}
    </div>
  );
}
