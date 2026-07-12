import { lazy, Suspense, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation } from "@tanstack/react-query";
import { api } from "../api.js";
import QuickReactionPopover from "./QuickReactionPopover.jsx";
import ReactorsPopover from "./ReactorsPopover.jsx";

// The full emoji picker is code-split: its bundle + emoji data load only when
// someone expands to it, so the feed stays light for people who never react (or
// who only use the quick reactions).
const EmojiPickerPopover = lazy(() => import("./EmojiPickerPopover.jsx"));

// A stable empty-array reference for the "no reactions" case, so the identity
// check below doesn't see a fresh `[]` every render (which would loop forever).
const NO_REACTIONS = [];

// Rough popover dimensions, used only to keep it on-screen (clamp + flip).
const PICKER_W = 348;
const PICKER_H = 400;

// Renders `children` in a portal on <body>, anchored just below the trigger
// button. This is essential, not cosmetic: the popover overflows its post and
// must paint above later feed content. Left in the flow it sits inside the
// feed's stacking context and later posts paint over it (the "translucent
// picker" bug). A body-level portal escapes that entirely.
//
// Positioned `absolute` in *page* coordinates (rect + scroll offset), not
// `fixed`, so it scrolls with the page and stays glued to its button — a fixed
// popover detaches and floats as you scroll.
function PopoverPortal({ anchorRef, width = PICKER_W, height = PICKER_H, children }) {
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const sx = window.scrollX;
    const sy = window.scrollY;
    let left = Math.min(r.left, window.innerWidth - width - 8);
    left = Math.max(8, left) + sx;
    // Below the button by default; flip above if there isn't room below the
    // viewport and there is room above. Decision uses viewport coords; the
    // result is stored in page coords (+ scroll) so it tracks the page.
    let top;
    if (r.bottom + height > window.innerHeight - 8 && r.top - height - 6 > 8) {
      top = r.top - height - 6 + sy;
    } else {
      top = r.bottom + 6 + sy;
    }
    setPos({ left, top });
  }, [anchorRef, width, height]);

  if (!pos) return null; // avoid a one-frame flash at (0,0) before we measure
  return createPortal(
    <div
      data-reaction-popover
      style={{ position: "absolute", left: pos.left, top: pos.top, zIndex: 60 }}
    >
      {children}
    </div>,
    document.body,
  );
}

// The reaction row under a post or comment: the aggregated `emoji × count` chips,
// an add-a-reaction button (opens the emoji picker), and a "who reacted" toggle.
// Pass exactly one of postId / commentId, plus the target's `reactions` summary.
//
// Counts are pruned per viewer server-side, so what's shown is already only the
// reactions from people you may see. Clicking a chip toggles your own reaction
// (add, or remove if you'd used that emoji); the toggle endpoint returns the
// fresh summary, so a click updates in place without refetching the whole feed —
// the next poll reconciles anything that changed underneath us.
export default function ReactionBar({ postId = null, commentId = null, reactions }) {
  const incoming = reactions ?? NO_REACTIONS;
  const target = postId ? { postId } : { commentId };
  const [items, setItems] = useState(incoming);
  // Which popover is open off the add button: null → closed, "quick" → the
  // four one-tap reactions, "full" → the whole emoji picker.
  const [menu, setMenu] = useState(null);
  const [whoOpen, setWhoOpen] = useState(false);
  const addBtnRef = useRef(null);
  const whoBtnRef = useRef(null);

  // Re-sync when the server's pruned summary changes underneath us (a feed poll,
  // or navigating back to this post) using the "adjust state during render"
  // pattern rather than an effect. React-Query's structural sharing keeps the
  // `reactions` reference stable when nothing changed, so this only fires on a
  // genuine change and doesn't clobber an in-flight toggle's result each render.
  const [syncedFrom, setSyncedFrom] = useState(incoming);
  if (incoming !== syncedFrom) {
    setSyncedFrom(incoming);
    setItems(incoming);
  }

  const toggle = useMutation({
    mutationFn: (emoji) => api.toggleReaction({ ...target, emoji }),
    onSuccess: (data) => setItems(data.reactions ?? []),
  });

  function react(emoji) {
    setMenu(null);
    toggle.mutate(emoji);
  }

  // The emoji the viewer has already used, so the quick popover can show them as
  // active (and re-tapping removes them).
  const reactedEmojis = new Set(
    items.filter((r) => r.reacted).map((r) => r.emoji),
  );

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {items.map((r) => (
        <button
          key={r.emoji}
          type="button"
          onClick={() => react(r.emoji)}
          aria-pressed={r.reacted}
          aria-label={`${r.emoji}, ${r.count}${r.reacted ? ", you reacted — tap to remove" : " — tap to react"}`}
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 transition ${
            r.reacted
              ? "border-accent bg-accent-tint text-accent-deep"
              : "border-line text-ink-faint hover:border-line-strong hover:bg-raised"
          }`}
        >
          <span aria-hidden="true" className="text-sm leading-none">
            {r.emoji}
          </span>
          <span className="font-mono text-xs tabular-nums">{r.count}</span>
        </button>
      ))}

      <button
        ref={addBtnRef}
        type="button"
        onClick={() => {
          setWhoOpen(false);
          setMenu((m) => (m ? null : "quick"));
        }}
        aria-label="Add a reaction"
        aria-expanded={menu !== null}
        className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-line text-ink-faint transition hover:border-line-strong hover:bg-raised hover:text-accent-deep"
      >
        {/* A smiley with a small plus — the near-universal "add reaction" glyph. */}
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="h-4 w-4"
        >
          <path d="M9.5 9.5h.01M14.5 9.5h.01M9 14a3.5 3.5 0 0 0 5 0" />
          <path d="M20.9 12.5a9 9 0 1 1-9.4-9.4" />
          <path d="M19 3v4M21 5h-4" />
        </svg>
      </button>

      {items.length > 0 && (
        <button
          ref={whoBtnRef}
          type="button"
          onClick={() => {
            setMenu(null);
            setWhoOpen((v) => !v);
          }}
          aria-expanded={whoOpen}
          className="ml-0.5 text-xs font-medium text-ink-faint transition hover:text-accent-deep"
        >
          Who reacted?
        </button>
      )}

      {menu === "quick" && (
        <PopoverPortal anchorRef={addBtnRef} width={244} height={56}>
          <QuickReactionPopover
            onPick={react}
            onMore={() => setMenu("full")}
            onClose={() => setMenu(null)}
            ignoreRef={addBtnRef}
            reactedEmojis={reactedEmojis}
          />
        </PopoverPortal>
      )}
      {menu === "full" && (
        <PopoverPortal anchorRef={addBtnRef}>
          <Suspense fallback={null}>
            <EmojiPickerPopover
              onPick={react}
              onClose={() => setMenu(null)}
              ignoreRef={addBtnRef}
            />
          </Suspense>
        </PopoverPortal>
      )}
      {whoOpen && (
        <PopoverPortal anchorRef={whoBtnRef} width={256} height={288}>
          <ReactorsPopover
            {...target}
            onClose={() => setWhoOpen(false)}
            ignoreRef={whoBtnRef}
          />
        </PopoverPortal>
      )}
    </div>
  );
}
