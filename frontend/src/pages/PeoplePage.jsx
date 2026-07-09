import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Avatar from "../components/Avatar.jsx";
import ConnectButton from "../components/ConnectButton.jsx";
import LoadMoreButton from "../components/LoadMoreButton.jsx";
import { useInfiniteList } from "../hooks.js";
import { api } from "../api.js";

// The people hub. Three segments share one page:
//   • Connections — people you're already connected with (the default: this is
//     the everyday job, a directory to reach a friend's profile in one tap —
//     it must not get buried behind a pile of requests)
//   • Discover    — every other member, each with a Connect toggle
//   • Requests    — people asking to connect, to approve or reject
// The active segment lives in the URL (`?tab=discover` / `?tab=requests`) so
// it's linkable and the back button works; no param means Connections. The old
// `/requests` URL redirects to `?tab=requests`.
const TABS = ["connections", "discover", "requests"];

export default function PeoplePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const param = searchParams.get("tab");
  const tab = TABS.includes(param) ? param : "connections";

  // The pending-request count for the Requests segment badge. Shares the
  // ["connectionRequests"] key with the nav badge, so approving/rejecting keeps
  // both in step. `count` is the paginator's true total (not just this page).
  const { data: requestsData } = useQuery({
    queryKey: ["connectionRequests"],
    queryFn: api.getConnectionRequests,
  });
  const pendingCount = requestsData?.count ?? 0;

  function selectTab(next) {
    // Connections is the default, so it needs no param — keeps the URL clean.
    // `replace` so flipping tabs doesn't stack history entries.
    setSearchParams(next === "connections" ? {} : { tab: next }, {
      replace: true,
    });
  }

  return (
    <div>
      <div className="border-b border-line px-5 py-4">
        <h1 className="font-display text-lg font-bold -tracking-[0.02em] text-ink">
          People
        </h1>
        <div
          role="tablist"
          aria-label="People"
          className="mt-3 inline-flex rounded-xl bg-ink/[0.05] p-1"
        >
          <SegmentButton
            active={tab === "connections"}
            onClick={() => selectTab("connections")}
          >
            Connections
          </SegmentButton>
          <SegmentButton
            active={tab === "discover"}
            onClick={() => selectTab("discover")}
          >
            Discover
          </SegmentButton>
          <SegmentButton
            active={tab === "requests"}
            onClick={() => selectTab("requests")}
          >
            Requests
            {pendingCount > 0 && (
              <span
                className={`ml-1.5 inline-flex min-w-[18px] items-center justify-center rounded-full px-1.5 text-[0.68rem] font-bold tabular-nums ${
                  tab === "requests"
                    ? "bg-accent text-white"
                    : "bg-accent/15 text-accent-deep"
                }`}
              >
                {pendingCount}
              </span>
            )}
          </SegmentButton>
        </div>
      </div>

      {tab === "requests" ? (
        <RequestsList />
      ) : tab === "discover" ? (
        <DiscoverList />
      ) : (
        <ConnectionsList onFindPeople={() => selectTab("discover")} />
      )}
    </div>
  );
}

function SegmentButton({ active, onClick, children }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`inline-flex items-center whitespace-nowrap rounded-lg px-4 py-1.5 text-sm font-medium tracking-tight transition ${
        active ? "bg-raised text-ink shadow-sm" : "text-ink-soft hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

// A shared row for the member lists: avatar + name, with the whole row (name)
// linking through to the profile. `trailing` is whatever sits on the right —
// a Connect toggle on Discover, a "view profile" chevron on Connections.
function PersonRow({ person, trailing }) {
  return (
    <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
      <Link to={`/u/${person.id}`} tabIndex={-1} aria-hidden="true">
        <Avatar user={person} size="md" />
      </Link>
      <Link
        to={`/u/${person.id}`}
        className="min-w-0 flex-1 truncate font-semibold text-ink hover:text-accent-deep"
      >
        {person.display_name}
      </Link>
      {trailing}
    </div>
  );
}

// Your connections — the everyday view. Deliberately a plain, tappable
// directory: the whole row opens the profile, and there's no Connect button to
// clutter it (disconnecting is a rarer action, offered on the profile itself).
function ConnectionsList({ onFindPeople }) {
  const query = useInfiniteList(["connections"], api.listConnections);
  const { items: people, isLoading, isError, error } = query;

  if (isLoading)
    return (
      <p className="px-6 py-10 text-center text-ink-faint">
        Loading connections…
      </p>
    );
  if (isError)
    return (
      <p className="px-6 py-10 text-center text-red-600">
        {error?.message || "Couldn't load your connections."}
      </p>
    );
  if (people.length === 0)
    return (
      <div className="px-6 py-10 text-center">
        <p className="text-ink-faint">You're not connected with anyone yet.</p>
        <button
          type="button"
          onClick={onFindPeople}
          className="btn btn-primary btn-sm mt-4"
        >
          Find people
        </button>
      </div>
    );

  return (
    <>
      {people.map((person) => (
        <PersonRow
          key={person.id}
          person={person}
          trailing={
            <Link
              to={`/u/${person.id}`}
              aria-label={`View ${person.display_name}'s profile`}
              className="shrink-0 rounded-lg p-1.5 text-ink-faint transition hover:bg-accent-tint hover:text-accent-deep"
            >
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path
                  d="M7.5 4.5l5 5.5-5 5.5"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </Link>
          }
        />
      ))}
      <LoadMoreButton query={query} />
    </>
  );
}

// People you're not yet connected with, paginated so the 21st+ is still
// reachable (and so connectable) via "Load more". Keyed under ["users"] so the
// connect/approve invalidations that refresh the pickers refresh this too.
function DiscoverList() {
  const query = useInfiniteList(["users", "discover"], api.listDiscover);
  const { items: users, isLoading, isError, error } = query;

  if (isLoading)
    return <p className="px-6 py-10 text-center text-ink-faint">Loading people…</p>;
  if (isError)
    return (
      <p className="px-6 py-10 text-center text-red-600">
        {error?.message || "Couldn't load people."}
      </p>
    );
  if (users.length === 0)
    return (
      <p className="px-6 py-10 text-center text-ink-faint">
        You're connected with everyone here already.
      </p>
    );

  return (
    <>
      {users.map((person) => (
        <PersonRow
          key={person.id}
          person={person}
          trailing={
            <ConnectButton
              userId={person.id}
              displayName={person.display_name}
              connectionStatus={person.connection_status}
            />
          }
        />
      ))}
      <LoadMoreButton query={query} />
    </>
  );
}

// Your inbox of incoming connection requests. Approve makes the connection
// mutual (you both start seeing each other's posts); Reject discards it. Uses a
// child of the ["connectionRequests"] key the nav badge and segment count hold,
// so invalidating ["connectionRequests"] refreshes all three.
function RequestsList() {
  const queryClient = useQueryClient();
  const query = useInfiniteList(
    ["connectionRequests", "list"],
    api.getConnectionRequests
  );
  const { items: requests, isLoading, isError, error } = query;

  const decide = useMutation({
    // `act` is api.approveRequest or api.rejectRequest.
    mutationFn: ({ act, id }) => act(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["connectionRequests"] });
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["connections"] });
      queryClient.invalidateQueries({ queryKey: ["feed"] });
    },
  });

  if (isLoading)
    return <p className="px-6 py-10 text-center text-ink-faint">Loading…</p>;
  if (isError)
    return (
      <p className="px-6 py-10 text-center text-red-600">
        {error?.message || "Couldn't load requests."}
      </p>
    );
  if (requests.length === 0)
    return (
      <p className="px-6 py-10 text-center text-ink-faint">
        No pending requests.
      </p>
    );

  return (
    <>
      {requests.map((req) => (
        <PersonRow
          key={req.id}
          person={req.requester}
          trailing={
            <>
              <button
                type="button"
                onClick={() =>
                  decide.mutate({ act: api.approveRequest, id: req.id })
                }
                disabled={decide.isPending}
                className="btn btn-primary btn-sm"
              >
                Approve
              </button>
              <button
                type="button"
                onClick={() =>
                  decide.mutate({ act: api.rejectRequest, id: req.id })
                }
                disabled={decide.isPending}
                className="btn btn-ghost btn-sm"
              >
                Reject
              </button>
            </>
          }
        />
      ))}
      <LoadMoreButton query={query} />
    </>
  );
}
