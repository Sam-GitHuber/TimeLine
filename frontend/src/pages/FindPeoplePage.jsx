import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import Avatar from "../components/Avatar.jsx";
import FollowButton from "../components/FollowButton.jsx";
import { api } from "../api.js";

// A minimal "find people to follow" list: every other member, each with a
// Follow/Unfollow toggle. Search and richer discovery can come later; for a
// small family app a plain list is enough (see phase-3 Definition of done).
export default function FindPeoplePage() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["users"],
    queryFn: api.listUsers,
  });

  const users = data?.results ?? [];

  return (
    <div>
      <h1 className="border-b border-slate-200 px-4 py-4 text-lg font-bold text-slate-900 sm:px-6">
        People
      </h1>

      {isLoading && (
        <p className="px-6 py-10 text-center text-slate-500">Loading people…</p>
      )}

      {isError && (
        <p className="px-6 py-10 text-center text-rose-600">
          {error?.message || "Couldn't load people."}
        </p>
      )}

      {!isLoading && !isError && users.length === 0 && (
        <p className="px-6 py-10 text-center text-slate-500">
          No one else here yet.
        </p>
      )}

      {users.map((person) => (
        <div
          key={person.id}
          className="flex items-center gap-3 border-b border-slate-200 px-4 py-3 sm:px-6"
        >
          <Link to={`/u/${person.id}`} tabIndex={-1} aria-hidden="true">
            <Avatar user={person} size="md" />
          </Link>
          <Link
            to={`/u/${person.id}`}
            className="min-w-0 flex-1 truncate font-semibold text-slate-900 hover:underline"
          >
            {person.display_name}
          </Link>
          <FollowButton userId={person.id} isFollowing={person.is_following} />
        </div>
      ))}
    </div>
  );
}
