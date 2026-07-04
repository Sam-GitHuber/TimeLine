import { Link, useOutletContext, useParams } from "react-router-dom";
import Avatar from "../components/Avatar.jsx";
import PostCard from "../components/PostCard.jsx";
import { getUserByUsername } from "../mockData.js";
import { formatAbsoluteTime } from "../utils.js";

// A single person's page: their details plus their own posts, newest-first.
export default function ProfilePage() {
  const { username } = useParams();
  const { posts } = useOutletContext();
  const user = getUserByUsername(username);

  // Someone navigated to a username that doesn't exist.
  if (!user) {
    return (
      <div className="px-6 py-16 text-center">
        <p className="text-lg font-medium text-slate-800">User not found</p>
        <p className="mt-1 text-slate-500">
          No one here goes by “@{username}”.
        </p>
        <Link
          to="/"
          className="mt-4 inline-block font-medium text-sky-600 hover:underline"
        >
          ← Back to the feed
        </Link>
      </div>
    );
  }

  const userPosts = posts
    .filter((post) => post.authorId === user.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return (
    <div>
      <section className="border-b border-slate-200 px-4 py-6 sm:px-6">
        <div className="flex items-start gap-4">
          <Avatar user={user} size="lg" />
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold text-slate-900">
              {user.displayName}
            </h1>
            <p className="text-slate-500">@{user.username}</p>
            <p className="mt-3 text-slate-800">{user.bio}</p>
            <p className="mt-3 text-sm text-slate-400">
              Joined {formatAbsoluteTime(user.joinedAt)}
            </p>
          </div>
        </div>
      </section>

      <h2 className="px-4 py-3 text-sm font-semibold uppercase tracking-wide text-slate-400 sm:px-6">
        Posts
      </h2>

      {userPosts.length > 0 ? (
        userPosts.map((post) => <PostCard key={post.id} post={post} />)
      ) : (
        <p className="px-6 py-10 text-center text-slate-500">
          {user.displayName} hasn’t posted yet.
        </p>
      )}
    </div>
  );
}
