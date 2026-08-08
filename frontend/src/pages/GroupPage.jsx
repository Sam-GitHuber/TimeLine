import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Avatar from "../components/Avatar.jsx";
import ComposeBox from "../components/ComposeBox.jsx";
import Timeline from "../components/Timeline.jsx";
import LoadMoreButton from "../components/LoadMoreButton.jsx";
import GroupMembersPanel from "../components/GroupMembersPanel.jsx";
import GroupInvitePicker from "../components/GroupInvitePicker.jsx";
import GroupActionsMenu from "../components/GroupActionsMenu.jsx";
import EventCard from "../components/events/EventCard.jsx";
import MonthGrid from "../components/events/MonthGrid.jsx";
import PlanEventForm from "../components/events/PlanEventForm.jsx";
import { useInfiniteList } from "../hooks.js";
import { eventLocalStart } from "../utils.js";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import { serverMessage, waitingMessage } from "../errors.js";
import { invalidateGroupMembership } from "../groupCache.js";
import { useMessaging } from "../messaging.jsx";

// A single group: a pinned header + its timeline. Members only — the backend
// 404s a non-member, and we render a friendly "not in this group" state for that.
//
// The timeline runs in both directions (Phase 8b). The composer "now" node rests
// at the top of the scroll on load; **upcoming events hang off the line above it**
// as post-shaped entries (furthest at the top, the nearest just above now — scroll
// up to travel forward in time), and past posts + past events flow below (scroll
// down into the past). The header pins under the nav, and a "Month" view swaps the
// spine for a calendar grid. Group actions live behind a "⋯" menu.
export default function GroupPage() {
  const { id } = useParams();
  const groupId = Number(id);
  const { user: me } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { openNew } = useMessaging();

  const [showInvite, setShowInvite] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [view, setView] = useState("agenda"); // "agenda" (the spine) | "month"
  // Set when "Start a chat" is refused because the member list never loaded —
  // see `startChat`.
  const [chatBlocked, setChatBlocked] = useState(false);

  const groupQuery = useQuery({
    queryKey: ["group", groupId],
    queryFn: () => api.getGroup(groupId),
    retry: false,
  });

  const postsQuery = useInfiniteList(["groupPosts", groupId], () =>
    api.getGroupPosts(groupId)
  );

  const upcomingQuery = useQuery({
    queryKey: ["groupEvents", groupId, "upcoming"],
    queryFn: () => api.getGroupEvents(groupId, "upcoming"),
  });
  const pastEventsQuery = useQuery({
    queryKey: ["groupEvents", groupId, "past"],
    queryFn: () => api.getGroupEvents(groupId, "past"),
  });
  const calendarQuery = useQuery({
    queryKey: ["groupCalendar", groupId],
    queryFn: () => api.getGroupCalendar(groupId),
    enabled: view === "month",
  });

  const membersQuery = useQuery({
    queryKey: ["groupMembers", groupId],
    queryFn: () => api.getGroupMembers(groupId),
  });

  // Both writes end your membership, so they refresh the home feed and the
  // personal calendar as well as the groups list — see `groupCache.js` for why
  // leaving the feed alone leaves it offering posts the server will refuse.
  const backToGroups = () => {
    invalidateGroupMembership(queryClient);
    navigate("/groups");
  };
  const leave = useMutation({
    mutationFn: () => api.removeGroupMember(groupId, me.pk),
    onSuccess: backToGroups,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteGroup(groupId),
    onSuccess: backToGroups,
  });

  // Two stacked sticky bars (nav + this group header) mean the now-node has to
  // clear *both*. Measure them so the header pins right under the nav and the
  // scroll-to-now leaves room for the pair.
  const headerRef = useRef(null);
  const [navH, setNavH] = useState(0);
  const [stickyH, setStickyH] = useState(0);
  useLayoutEffect(() => {
    function measure() {
      const nav = document.querySelector("header.sticky");
      const nH = nav?.offsetHeight || 0;
      setNavH(nH);
      setStickyH(nH + (headerRef.current?.offsetHeight || 0));
    }
    measure();
    window.addEventListener("resize", measure);
    let ro;
    if (typeof ResizeObserver !== "undefined" && headerRef.current) {
      ro = new ResizeObserver(measure);
      ro.observe(headerRef.current);
    }
    return () => {
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, [groupQuery.data]);

  // Rest the now-node just below the two sticky bars on load. Once per group.
  const nowRef = useRef(null);
  const scrolledRef = useRef(false);
  useEffect(() => {
    scrolledRef.current = false;
  }, [groupId]);
  useEffect(() => {
    if (scrolledRef.current) return;
    if (groupQuery.isLoading || upcomingQuery.isLoading) return;
    const el = nowRef.current;
    if (!el) return;
    scrolledRef.current = true;
    const raf =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (cb) => cb();
    raf(() => {
      try {
        el.scrollIntoView({ block: "start" });
      } catch {
        /* no layout engine (tests) */
      }
    });
  }, [groupId, groupQuery.isLoading, upcomingQuery.isLoading]);

  // Switching views moves you somewhere sensible: the month grid to the top,
  // the agenda back to now.
  useEffect(() => {
    if (!scrolledRef.current) return; // don't fight the initial load
    if (view === "month") window.scrollTo({ top: 0, behavior: "smooth" });
    else
      try {
        nowRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch {
        /* no layout engine */
      }
  }, [view]);

  if (groupQuery.isError && groupQuery.error?.status === 404) {
    return (
      <div className="px-6 py-16 text-center">
        <p className="text-lg font-medium text-ink">Group not available</p>
        <p className="mt-1 text-ink-faint">
          This group doesn't exist, or you're not a member of it.
        </p>
        <Link
          to="/groups"
          className="mt-4 inline-block font-medium text-accent-deep hover:underline"
        >
          ← Back to groups
        </Link>
      </div>
    );
  }
  const group = groupQuery.data;

  // **The group we have beats an error about refreshing it** — same rule as the
  // profile page, for the same reason: a failed refetch keeps its data and only
  // flips `status` to 'error', and with `staleTime` 0 and `refetchOnWindowFocus`
  // on, returning to a backgrounded tab refetches this key. Reading `isError`
  // first threw away the timeline, the upcoming events and the calendar over one
  // lost request. The 404 branch above still wins over the cached copy — not a
  // member, or no such group, is an answer about *now*.
  if (!group) {
    if (groupQuery.isError) {
      return (
        <div className="px-6 py-16 text-center">
          <p className="text-lg font-medium text-red-600">
            {serverMessage(groupQuery.error, "Couldn't load this group.")}
          </p>
          <button
            type="button"
            onClick={() => groupQuery.refetch()}
            className="btn btn-ghost btn-sm mt-4"
          >
            Try again
          </button>
        </div>
      );
    }
    return (
      <p className="px-6 py-10 text-center text-ink-faint">
        {waitingMessage(groupQuery)}
      </p>
    );
  }

  const isAdmin = group.your_role === "admin";
  const posts = postsQuery.items;

  // Cancelled events are tombstones, not upcoming plans — leave them off the
  // upcoming spine/staging (they resurface as a past recap once their date
  // passes, and the detail page keeps them). This also keeps the "N upcoming"
  // cue count equal to the number of entries actually shown above now.
  /**
   * **Four more queries hang off this page, and each can fail on its own**
   * (#314). `groupQuery` above has had an error branch since #310; none of the
   * others did, so a page that renders a perfectly good header could
   * simultaneously claim the group has no posts, no events and an empty
   * calendar — none of which anyone had asked the server about.
   *
   * `!data` rather than a bare `isError` throughout, the same way round as the
   * group branch above: a failed *refetch* keeps what's already on screen
   * (#310/#313). Note `upcoming` is the one whose absence is otherwise
   * *invisible* — a failed fetch makes `upcomingCount` compute 0, which hides
   * the "↑ N upcoming events" cue along with the events themselves, so nothing
   * on screen distinguishes "nothing is planned" from "we couldn't ask".
   */
  const postsLoadFailed = postsQuery.isError && !postsQuery.data;
  const upcomingLoadFailed = upcomingQuery.isError && !upcomingQuery.data;
  const pastEventsLoadFailed =
    pastEventsQuery.isError && !pastEventsQuery.data;
  const calendarLoadFailed = calendarQuery.isError && !calendarQuery.data;

  const upcoming = upcomingQuery.data || [];
  const live = upcoming.filter((e) => e.status !== "cancelled");
  const staging = live.filter((e) => !e.event_date);
  // Furthest-first, so the nearest event ends up at the bottom of the spine's
  // future region — right above the now-node.
  // Ordered by each event's own wall-clock start, the same value the timeline
  // below groups past events by — see `eventLocalStart`.
  const scheduledFuture = live
    .filter((e) => e.event_date)
    .sort((a, b) => eventLocalStart(b) - eventLocalStart(a));
  const upcomingCount = live.length;

  function confirmLeave() {
    if (window.confirm(`Leave ${group.name}? You can be re-invited.`)) leave.mutate();
  }
  function confirmDelete() {
    if (
      window.confirm(
        `Delete ${group.name}? This removes the group and all its posts for everyone. This can't be undone.`
      )
    )
      remove.mutate();
  }
  /**
   * **A failed read must not become a wrong write** (#314). The roster is what
   * seeds the new chat, and `?? []` turned "we couldn't ask who's in this
   * group" into "this group has nobody in it" — so opening this while
   * `membersQuery` is errored created a group chat with an *empty* member list
   * rather than the action refusing.
   *
   * The menu item is already disabled while the roster is loading, so the case
   * that reaches here is the one that matters: offline, where the query sits
   * paused, `isLoading` is false and the item is live. Refuse and say so.
   */
  function startChat() {
    if (!membersQuery.data) {
      setChatBlocked(true);
      membersQuery.refetch();
      return;
    }
    setChatBlocked(false);
    openNew({
      groupId: group.id,
      groupName: group.name,
      memberIds: membersQuery.data.map((m) => m.user.id),
    });
  }

  // "Plan an event" lives in the ⋯ menu; opening it reveals the form at the now
  // boundary, so scroll there (in the spine view) to bring it into view.
  function startPlanning() {
    setPlanning(true);
    if (view === "agenda") {
      const raf =
        typeof requestAnimationFrame === "function"
          ? requestAnimationFrame
          : (cb) => cb();
      raf(() => {
        try {
          nowRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        } catch {
          /* no layout engine */
        }
      });
    }
  }
  const planForm = (
    <PlanEventForm groupId={group.id} onClose={() => setPlanning(false)} />
  );

  return (
    <div>
      {/* The pinned group header — sticks under the nav, with the Agenda/Month
          toggle so it stays reachable while the timeline scrolls behind it. */}
      <div
        ref={headerRef}
        className="sticky z-[9] border-b border-line bg-surface/90 backdrop-blur"
        style={{ top: navH }}
      >
        <div className="flex items-center gap-3 px-5 py-3">
          <Avatar
            user={{ display_name: group.name, avatar_thumb: group.avatar_thumb }}
            size="sm"
          />
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-display text-lg font-bold -tracking-[0.02em] text-ink">
              {group.name}
            </h1>
            <p className="text-xs text-ink-faint">
              {group.member_count} {group.member_count === 1 ? "member" : "members"}
            </p>
          </div>
          <div className="ev-toggle" role="group" aria-label="Group view">
            <button
              type="button"
              onClick={() => setView("agenda")}
              aria-pressed={view === "agenda"}
              className={view === "agenda" ? "ev-toggle--on" : ""}
            >
              Timeline
            </button>
            <button
              type="button"
              onClick={() => setView("month")}
              aria-pressed={view === "month"}
              className={view === "month" ? "ev-toggle--on" : ""}
            >
              Calendar
            </button>
          </div>
          <GroupActionsMenu
            groupId={group.id}
            isAdmin={isAdmin}
            membersOpen={showMembers}
            membersBusy={membersQuery.isLoading}
            onPlanEvent={startPlanning}
            onInvite={() => setShowInvite((v) => !v)}
            onMembers={() => setShowMembers((v) => !v)}
            onStartChat={startChat}
            onLeave={confirmLeave}
            onDelete={confirmDelete}
          />
        </div>
        {group.description && (
          <p className="whitespace-pre-wrap break-words px-5 pb-3 text-sm text-ink-soft">
            {group.description}
          </p>
        )}
      </div>

      {(leave.isError || remove.isError) && (
        <p role="alert" className="px-5 py-2 text-sm text-red-600">
          {serverMessage(
            leave.error || remove.error,
            "Something went wrong."
          )}
        </p>
      )}

      {chatBlocked && !membersQuery.data && (
        <p role="alert" className="px-5 py-2 text-sm text-red-600">
          Couldn’t check who’s in this group, so there’s no one to start a chat
          with yet. Trying again — give it a moment.
        </p>
      )}

      {showInvite && (
        <GroupInvitePicker groupId={group.id} onClose={() => setShowInvite(false)} />
      )}
      {showMembers && <GroupMembersPanel groupId={group.id} isAdmin={isAdmin} />}

      {view === "month" ? (
        <section className="px-5 py-5">
          {/* No spine in the month view, so the plan form isn't inset. */}
          {planning && <div className="mb-4">{planForm}</div>}
          {calendarLoadFailed ? (
            // Not an empty grid: a drawn month with nothing in it is the most
            // confident possible lie about a calendar.
            <div className="mt-4 py-10 text-center">
              <p className="font-medium text-red-600">
                {serverMessage(
                  calendarQuery.error,
                  "Couldn’t load this group’s calendar."
                )}
              </p>
              <button
                type="button"
                onClick={() => calendarQuery.refetch()}
                className="btn btn-ghost btn-sm mt-4"
              >
                Try again
              </button>
            </div>
          ) : !calendarQuery.data ? (
            <p className="mt-4 text-sm text-ink-faint">
              {waitingMessage(calendarQuery)}
            </p>
          ) : (
            <div className="mt-4">
              <MonthGrid events={calendarQuery.data || []} />
            </div>
          )}
        </section>
      ) : (
        <Timeline
          posts={posts}
          pastEvents={pastEventsQuery.data || []}
          futureEvents={scheduledFuture}
          header={
            <>
              {/* Date-less events being planned sit off the line, just above now
                  — inset to the body column so they clear the spine. */}
              {staging.length > 0 && (
                <div className="tl-inset my-3">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-faint">
                    Being planned
                  </p>
                  <div className="space-y-2">
                    {staging.map((e) => (
                      <EventCard key={e.id} event={e} />
                    ))}
                  </div>
                </div>
              )}

              {/* Where the page rests on load — the boundary between future and now. */}
              <div
                ref={nowRef}
                className="tl-now-anchor"
                style={{ scrollMarginTop: stickyH + 8 }}
                aria-hidden="true"
              />

              {/* Where the missing future gets said. The cue below only
                  renders when there *are* upcoming events, so without this a
                  failed fetch leaves the region silent and indistinguishable
                  from a group with nothing planned. Inset to the body column,
                  like the staging block above it. */}
              {upcomingLoadFailed && (
                <p className="tl-inset my-3 text-sm text-red-600">
                  {serverMessage(
                    upcomingQuery.error,
                    "Couldn’t load what’s coming up."
                  )}{" "}
                  <button
                    type="button"
                    onClick={() => upcomingQuery.refetch()}
                    className="font-medium underline"
                  >
                    Try again
                  </button>
                </p>
              )}

              {upcomingCount > 0 && (
                <button
                  type="button"
                  onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
                  className="ev-upcoming-cue"
                  aria-label={`Scroll up to ${upcomingCount} upcoming event${upcomingCount === 1 ? "" : "s"}`}
                >
                  <span aria-hidden="true">↑</span>
                  {upcomingCount} upcoming event{upcomingCount === 1 ? "" : "s"}
                  <span aria-hidden="true">↑</span>
                </button>
              )}

              {/* The plan form (opened from the ⋯ menu) appears at the now
                  boundary, inset so its inputs sit to the right of the spine. */}
              {planning && (
                <div className="tl-inset border-b border-line py-3">{planForm}</div>
              )}
              <ComposeBox group={group.id} />
            </>
          }
        />
      )}

      {view === "agenda" && (
        <>
          {/* The loudest one. "No posts yet. Be the first…" on a group with two
              years of shared history reads as a brand-new group, and the
              natural response to that sentence is to post into it again. */}
          {postsLoadFailed ? (
            <div className="px-6 py-12 text-center">
              <p className="font-medium text-red-600">
                {serverMessage(
                  postsQuery.error,
                  "Couldn’t load this group’s posts."
                )}
              </p>
              <button
                type="button"
                onClick={() => postsQuery.refetch()}
                className="btn btn-ghost btn-sm mt-4"
              >
                Try again
              </button>
            </div>
          ) : !postsQuery.data ? (
            <p className="px-6 py-10 text-center text-ink-faint">
              {waitingMessage(postsQuery)}
            </p>
          ) : posts.length === 0 ? (
            <p className="px-6 py-12 text-center text-ink-faint">
              No posts yet. Be the first to share something with the group.
            </p>
          ) : (
            postsQuery.isError && (
              // The partial case: a timeline that stopped short looks exactly
              // like one that ended (`EventPhotos`' shape).
              <p className="px-6 pb-4 text-center text-sm text-red-600">
                Couldn’t load any older posts.
              </p>
            )
          )}
          {/* Past event recaps live on the same spine as the posts, so their
              absence reads as "nothing happened", not "we couldn't ask". */}
          {pastEventsLoadFailed && (
            <p className="px-6 pb-4 text-center text-sm text-red-600">
              {serverMessage(
                pastEventsQuery.error,
                "Couldn’t load this group’s past events."
              )}
            </p>
          )}
          <LoadMoreButton query={postsQuery} />
          <BackToNowPill targetRef={nowRef} topOffset={stickyH} />
        </>
      )}
    </div>
  );
}

// A floating pill that appears once the now-node has scrolled out of the live
// window — up into the future or down into the past — pointing the way home.
function BackToNowPill({ targetRef, topOffset }) {
  const [state, setState] = useState({ show: false, dir: "down" });
  useEffect(() => {
    function updatePill() {
      const el = targetRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      const vh = window.innerHeight || 0;
      if (top < topOffset) setState({ show: true, dir: "up" });
      else if (top > vh) setState({ show: true, dir: "down" });
      else setState((s) => (s.show ? { ...s, show: false } : s));
    }
    updatePill();
    window.addEventListener("scroll", updatePill, { passive: true });
    window.addEventListener("resize", updatePill);
    return () => {
      window.removeEventListener("scroll", updatePill);
      window.removeEventListener("resize", updatePill);
    };
  }, [targetRef, topOffset]);

  if (!state.show) return null;
  return (
    <button
      type="button"
      onClick={() =>
        targetRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
      }
      className="tl-back-to-now"
    >
      <span aria-hidden="true">{state.dir === "up" ? "↑" : "↓"}</span> Back to now
    </button>
  );
}
