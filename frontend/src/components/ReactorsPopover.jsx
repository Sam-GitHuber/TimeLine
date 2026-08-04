import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";

/**
 * The cache key for one target's reactor list.
 *
 * Exported because **anything that toggles a reaction has to invalidate it**,
 * and this cache outlives the popover: it's filled while the popover is open and
 * kept after it unmounts, so the next open renders the old list first (there's
 * data, so `isLoading` is false) and only flips when the refetch lands. Worse
 * than the flicker, that stale list is *actionable* on a message — a removed
 * reaction still saying "tap to remove" would call the toggle again and silently
 * put it back. One helper so the key can't be spelled two ways and drift.
 *
 * Mirrors `reactorsQueryKey` in `mobile/src/components/ReactorsSheet.tsx`.
 */
export function reactorsQueryKey({
  postId = null,
  commentId = null,
  messageId = null,
  eventId = null,
} = {}) {
  return ["reactors", postId, commentId, messageId, eventId];
}

// "Who reacted", grouped by emoji. Pass exactly one of postId / commentId /
// messageId / eventId.
//
// **Post and comment reactors are pruned per viewer, server-side**: that list
// only ever contains people you're connected with (plus yourself), so a reactor
// you don't know is never named here. Two people can therefore see different
// lists on the same post, which is correct rather than a bug (reactions.md).
//
// A **message**'s reactors aren't pruned, because a chat's active participants
// are a clique by construction — anyone who can see the message can already see
// everyone who reacted, so everyone in a thread sees the same list. Nothing here
// changes either way: the server decides and this renders what arrives.
//
// **Your own row can be clicked to take your reaction off** when the caller
// supplies `onRemoveReaction` — the message thread does (Phase 9b M9c). That's
// the standard shape: the list is where you go to look at a reaction, so it's
// also where you expect to be able to undo yours. Callers that don't pass it
// (the feed, whose chips toggle on click already) get the plain read-only list,
// unchanged.
export default function ReactorsPopover({
  postId = null,
  commentId = null,
  messageId = null,
  eventId = null,
  onClose,
  ignoreRef,
  /**
   * Which row is yours, so it can offer to remove your reaction. A prop rather
   * than a `useAuth()` call on purpose: this popover is otherwise a pure
   * renderer of what the server sent, and reaching for context here would make
   * every caller — the feed's `ReactionBar` included — depend on an auth
   * provider for a feature only the message thread uses.
   */
  meId = null,
  /**
   * Take your own reaction off from inside the popover. Omitted when the viewer
   * can't write to the target (a thread you've been disconnected from), which
   * leaves the list readable but not actionable — the same line the server
   * draws.
   */
  onRemoveReaction,
}) {
  const wrapRef = useRef(null);
  const target = { postId, commentId, messageId, eventId };

  const { data, isLoading, isError } = useQuery({
    queryKey: reactorsQueryKey(target),
    queryFn: () => api.getReactors(target),
  });

  useEffect(() => {
    function onPointerDown(e) {
      if (ignoreRef?.current && ignoreRef.current.contains(e.target)) return;
      if (wrapRef.current && !wrapRef.current.contains(e.target)) onClose();
    }
    function onKeyDown(e) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, ignoreRef]);

  return (
    <div
      ref={wrapRef}
      role="dialog"
      aria-label="Who reacted"
      className="max-h-72 w-64 overflow-y-auto rounded-2xl border border-line bg-raised p-3 shadow-lg"
    >
      {isLoading && <p className="text-sm text-ink-faint">Loading…</p>}
      {isError && (
        <p className="text-sm text-red-600">Couldn't load reactions.</p>
      )}
      {data && data.length === 0 && (
        <p className="text-sm text-ink-faint">No reactions yet.</p>
      )}
      {data?.map((group) => (
        <div key={group.emoji} className="mb-2.5 last:mb-0">
          <div className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-ink">
            <span aria-hidden="true">{group.emoji}</span>
            <span className="font-mono text-xs text-ink-faint">
              {group.count}
            </span>
          </div>
          <ul className="space-y-0.5 pl-1">
            {group.users.map((user) => (
              <li key={user.id}>
                {onRemoveReaction && meId != null && user.id === meId ? (
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onRemoveReaction(group.emoji);
                    }}
                    className="text-left text-sm text-ink-faint transition hover:text-accent-deep"
                  >
                    {user.display_name}
                    <span className="ml-1.5 text-xs italic">
                      — tap to remove
                    </span>
                  </button>
                ) : (
                  <Link
                    to={`/u/${user.id}`}
                    onClick={onClose}
                    className="text-sm text-ink-faint transition hover:text-accent-deep"
                  >
                    {user.display_name}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
