import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";

// "Who reacted", grouped by emoji. The list is pruned server-side to people the
// viewer may see (their connections), so — like the reaction counts themselves —
// a not-connected reactor never appears here. Pass exactly one of postId /
// commentId.
export default function ReactorsPopover({
  postId = null,
  commentId = null,
  onClose,
  ignoreRef,
}) {
  const wrapRef = useRef(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["reactors", postId ? `p${postId}` : `c${commentId}`],
    queryFn: () => api.getReactors({ postId, commentId }),
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
                <Link
                  to={`/u/${user.id}`}
                  onClick={onClose}
                  className="text-sm text-ink-faint transition hover:text-accent-deep"
                >
                  {user.display_name}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
