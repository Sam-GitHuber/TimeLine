import { lazy, Suspense, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation } from "@tanstack/react-query";
import { api } from "../api.js";
import { serverMessage } from "../errors.js";
import QuickReactionPopover from "./QuickReactionPopover.jsx";
import ReactorsPopover from "./ReactorsPopover.jsx";

// The full emoji picker is code-split: its bundle + emoji data load only when
// someone expands to it, so the feed stays light for people who never react (or
// who only use the quick reactions).
const EmojiPickerPopover = lazy(() => import("./EmojiPickerPopover.jsx"));

// A stable empty-array reference for the "no reactions" case, so the identity
// check below doesn't see a fresh `[]` every render (which would loop forever).
const NO_REACTIONS = [];

// What a rejection sounds like when the server didn't write anything readable
// itself. Named per direction rather than generically because a chip does two
// opposite things depending on whether that emoji is already yours, and "it
// didn't work" leaves you unable to tell which of them didn't happen.
const FAILURES = {
  add: "Couldn’t add that reaction — try again.",
  remove: "Couldn’t remove that reaction — try again.",
};

// Whether the viewer has reacted with `emoji`, according to a server summary.
// An emoji absent from the summary is one nobody has used, so: no.
function hasReacted(summary, emoji) {
  return summary.some((r) => r.emoji === emoji && r.reacted);
}

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
  // A rejected toggle, tagged with the emoji it was for and whether that emoji
  // was yours when you tapped — see the clear-condition below.
  const [failure, setFailure] = useState(null);
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

  // Retire the message once the server's own answer moves to the state that tap
  // was reaching for — the toggle landed and only its response was lost, so
  // "couldn't add that reaction" would now be sitting beside a chip that says
  // you did. Nothing else clears it: a summary that changed for some other
  // reason (someone else reacted, a different emoji of yours toggled) is not
  // confirmation of your attempt, and clearing on any resync is the swallow
  // issue #231 describes. The comparison is against `mine`, recorded at the
  // attempt rather than at the rejection, so a refetch landing in the same
  // render batch as the rejection can't eat the message before it's painted.
  //
  // Testing "moved off what it was" rather than "arrived at what we wanted" is
  // the same condition here, since a chip is yours or it isn't — unlike
  // ConnectButton's four states, where the two halves are genuinely different
  // questions and both have to be asked.
  //
  // `items` is the right thing to read: it is only ever assigned a summary the
  // server sent, whether from the re-sync above or from a later toggle's own
  // response. Nothing here is optimistic.
  if (failure && hasReacted(items, failure.emoji) !== failure.mine) {
    setFailure(null);
  }

  const toggle = useMutation({
    mutationFn: (emoji) => api.toggleReaction({ ...target, emoji }),
    onSuccess: (data) => setItems(data.reactions ?? []),
  });

  // Awaited rather than fired-and-forgotten so the failure can be tagged with
  // what was true when you tapped. Reacting is a small, cheap gesture, so a
  // rejection has to say so rather than leave the tap looking like it worked:
  // the chips only ever repaint from `onSuccess`, the popover closes either
  // way, and a silent failure reads as a missed button — so you tap again, at a
  // server that may have taken the first one, where the second tap *removes* it.
  async function react(emoji) {
    setMenu(null);
    const mine = hasReacted(items, emoji);
    setFailure(null);
    try {
      await toggle.mutateAsync(emoji);
    } catch (err) {
      // The server's own words are the point here: the rules that reject a
      // reaction — the per-target distinct-emoji cap, emoji validation — are
      // written for a person. `serverMessage` is what keeps the browser's
      // "Failed to fetch" and a body-less 500's "Request failed (500)" out,
      // both of which a bare `err.message` would show (issue #240).
      setFailure({
        emoji,
        mine,
        text: serverMessage(err, mine ? FAILURES.remove : FAILURES.add),
      });
    }
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
        {/* A smiley with a small plus — the near-universal "add reaction" glyph.
            These paths are duplicated in `mobile/src/components/ReactionBar.tsx`
            so both clients draw the same icon — change them together. */}
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

      {/* Reported where the tap happened, under the row rather than beside it:
          this row wraps, and a message sharing a line with the chips would be
          pushed off the end of a busy one. `w-full` takes its own line in the
          same flex container. */}
      {failure && (
        <p role="alert" className="w-full text-xs leading-snug text-red-600">
          {failure.text}
        </p>
      )}
    </div>
  );
}
