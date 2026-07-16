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
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
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

  const leave = useMutation({
    mutationFn: () => api.removeGroupMember(groupId, me.pk),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["groups"] });
      navigate("/groups");
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteGroup(groupId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["groups"] });
      navigate("/groups");
    },
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
  if (groupQuery.isError) {
    return (
      <div className="px-6 py-16 text-center">
        <p className="text-lg font-medium text-red-600">
          {groupQuery.error?.message || "Couldn't load this group."}
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
  if (groupQuery.isLoading) {
    return <p className="px-6 py-10 text-center text-ink-faint">Loading…</p>;
  }

  const group = groupQuery.data;
  const isAdmin = group.your_role === "admin";
  const posts = postsQuery.items;

  const upcoming = upcomingQuery.data || [];
  const staging = upcoming.filter((e) => !e.event_date && e.status !== "cancelled");
  // Furthest-first, so the nearest event ends up at the bottom of the spine's
  // future region — right above the now-node.
  const scheduledFuture = upcoming
    .filter((e) => e.event_date)
    .sort(
      (a, b) =>
        new Date(b.starts_at || b.event_date) -
        new Date(a.starts_at || a.event_date)
    );
  const upcomingCount = upcoming.filter((e) => e.status !== "cancelled").length;

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
  function startChat() {
    openNew({
      groupId: group.id,
      groupName: group.name,
      memberIds: (membersQuery.data ?? []).map((m) => m.user.id),
    });
  }

  const planBar = (
    <div className="border-b border-line px-5 py-2 text-center">
      {!planning && (
        <button
          type="button"
          onClick={() => setPlanning(true)}
          className="btn btn-primary btn-sm"
        >
          Plan an event
        </button>
      )}
      {planning && (
        <div className="pt-1 text-left">
          <PlanEventForm groupId={group.id} onClose={() => setPlanning(false)} />
        </div>
      )}
    </div>
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
          <div className="ev-toggle" role="group" aria-label="Timeline view">
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
              Month
            </button>
          </div>
          <GroupActionsMenu
            groupId={group.id}
            isAdmin={isAdmin}
            membersOpen={showMembers}
            membersBusy={membersQuery.isLoading}
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
          {leave.error?.message || remove.error?.message || "Something went wrong."}
        </p>
      )}

      {showInvite && (
        <GroupInvitePicker groupId={group.id} onClose={() => setShowInvite(false)} />
      )}
      {showMembers && <GroupMembersPanel groupId={group.id} isAdmin={isAdmin} />}

      {view === "month" ? (
        <section className="px-5 py-5">
          {planBar}
          {calendarQuery.isLoading ? (
            <p className="mt-4 text-sm text-ink-faint">Loading calendar…</p>
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
              {/* Date-less events being planned sit off the line, just above now. */}
              {staging.length > 0 && (
                <div className="ev-staging mx-5 my-3">
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

              {planBar}
              <ComposeBox group={group.id} />
            </>
          }
        />
      )}

      {view === "agenda" && (
        <>
          {postsQuery.isLoading && (
            <p className="px-6 py-10 text-center text-ink-faint">Loading posts…</p>
          )}
          {!postsQuery.isLoading && posts.length === 0 && (
            <p className="px-6 py-12 text-center text-ink-faint">
              No posts yet. Be the first to share something with the group.
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
