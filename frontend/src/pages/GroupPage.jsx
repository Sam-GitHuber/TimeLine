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
import EventsSection from "../components/events/EventsSection.jsx";
import { useInfiniteList } from "../hooks.js";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import { useMessaging } from "../messaging.jsx";

// A single group: a compact header + its timeline. Members only — the backend
// 404s a non-member, and we render a friendly "not in this group" state for that.
// The group's actions (Invite, Members, Start a chat, Leave, Edit, Delete) live
// behind a single "⋯" menu so the page opens on the timeline, not a wall of
// buttons.
//
// The header (name + ⋯ + description) is a **second sticky bar**, pinned directly
// below the nav — the upcoming region and the timeline scroll up *behind* it, so
// the group's identity stays put while you move through time. The timeline itself
// is bidirectional (Phase 8b): the composer "now" node rests at the top of the
// scroll on load, upcoming events extend the line *above* it (scroll up into the
// planned future), past posts + events below (scroll down). A "back to now" pill
// appears once you've wandered either way.
export default function GroupPage() {
  const { id } = useParams();
  const groupId = Number(id);
  const { user: me } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { openNew } = useMessaging();

  const [showInvite, setShowInvite] = useState(false);
  const [showMembers, setShowMembers] = useState(false);

  const groupQuery = useQuery({
    queryKey: ["group", groupId],
    queryFn: () => api.getGroup(groupId),
    retry: false,
  });

  const postsQuery = useInfiniteList(["groupPosts", groupId], () =>
    api.getGroupPosts(groupId)
  );

  // Upcoming events (the forward region) — fetched here rather than inside
  // EventsSection so this page can settle its scroll-to-now once the region's
  // height is known. Past events fall into the timeline below as recap cards.
  const upcomingQuery = useQuery({
    queryKey: ["groupEvents", groupId, "upcoming"],
    queryFn: () => api.getGroupEvents(groupId, "upcoming"),
  });
  const pastEventsQuery = useQuery({
    queryKey: ["groupEvents", groupId, "past"],
    queryFn: () => api.getGroupEvents(groupId, "past"),
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
  // clear *both*. We measure the nav and header heights so the header pins right
  // under the nav and the scroll-to-now leaves room for the pair. Measured in a
  // layout effect (before paint, no flicker) and kept fresh on resize.
  const headerRef = useRef(null);
  const [navH, setNavH] = useState(0);
  const [stickyH, setStickyH] = useState(0); // nav + header, the total pinned top

  useLayoutEffect(() => {
    function measure() {
      const nav = document.querySelector("header.sticky");
      const nH = nav?.offsetHeight || 0;
      const hH = headerRef.current?.offsetHeight || 0;
      setNavH(nH);
      setStickyH(nH + hH);
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

  // Rest the now-node just below the two sticky bars on load (so upcoming sits
  // above the fold). Once per group; a no-op without a layout engine (tests).
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
        /* no layout engine (tests) — nothing to scroll */
      }
    });
  }, [groupId, groupQuery.isLoading, upcomingQuery.isLoading]);

  // 404 → you're not a member (or it doesn't exist). Don't leak which.
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

  return (
    <div>
      {/* The pinned group header — sticks directly under the nav (top: navH), so
          the timeline and upcoming region scroll up behind it. */}
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
          {leave.error?.message ||
            remove.error?.message ||
            "Something went wrong."}
        </p>
      )}

      {showInvite && (
        <GroupInvitePicker groupId={group.id} onClose={() => setShowInvite(false)} />
      )}

      {showMembers && <GroupMembersPanel groupId={group.id} isAdmin={isAdmin} />}

      {/* The forward region: upcoming events, above the now-node. */}
      <EventsSection
        groupId={group.id}
        events={upcomingQuery.data || []}
        isLoading={upcomingQuery.isLoading}
      />

      {/* The now-node anchor — where the page rests on load. Its scroll-margin
          clears both sticky bars so the composer lands just beneath them. */}
      <div
        ref={nowRef}
        className="tl-now-anchor"
        style={{ scrollMarginTop: stickyH + 8 }}
        aria-hidden="true"
      />

      <Timeline
        posts={posts}
        pastEvents={pastEventsQuery.data || []}
        header={<ComposeBox group={group.id} />}
      />

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
    </div>
  );
}

// A floating pill that appears once the now-node has scrolled out of the live
// window — up into the future or down into the past — pointing the way home.
// A plain scroll listener (rAF-free; the check is cheap) keeps it dependency-safe
// and degrades to hidden without a layout engine (tests).
function BackToNowPill({ targetRef, topOffset }) {
  const [state, setState] = useState({ show: false, dir: "down" });
  useEffect(() => {
    function update() {
      const el = targetRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      const vh = window.innerHeight || 0;
      if (top < topOffset) setState({ show: true, dir: "up" }); // now is above → past
      else if (top > vh) setState({ show: true, dir: "down" }); // now is below → future
      else setState((s) => (s.show ? { ...s, show: false } : s));
    }
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
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
