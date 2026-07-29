import { lazy, Suspense, useRef, useState } from "react";
import DrawerPopover from "./DrawerPopover.jsx";
import { MenuItem } from "./DrawerMenu.jsx";

// The full emoji picker is code-split, the same way the feed's `ReactionBar`
// loads it: its bundle + emoji data arrive only when someone actually expands
// past the six quick emoji. Keep it lazy.
const EmojiPickerPopover = lazy(() => import("../EmojiPickerPopover.jsx"));

/**
 * The one-tap emoji above the menu's items (Phase 9b M9c), and the row's whole
 * design brief: cover the replies people actually send so the `＋` is the
 * exception rather than the route.
 *
 * **Deliberately not the feed's four.** `QuickReactionPopover` keeps its quick
 * set strictly positive (👍 ❤️ 😂 🎉) because reacting to someone's *post* with
 * 😢 reads as a verdict on it. In a conversation the opposite is true: 😮 and 😢
 * to someone's news are the warm, human answers, and a set that can only be
 * cheerful makes you type a whole message to say "oh no". Different context,
 * different set — not an oversight. Same six as the app's `MessageActionMenu`.
 */
const CHAT_QUICK_EMOJI = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

// The ⋯ action menu on a message bubble (Phase 9b M9b — the web's answer to the
// app's long-press menu; M9c added the quick-reaction row).
//
// **Hover, not long-press**, which is the one thing that differs from the phone
// and differs because the medium does: a desktop has a pointer, and the drawer
// already surfaced its inline Delete this way. The trigger stays in the DOM and
// is revealed by the bubble row's `group-hover` — and by `:focus-visible`, so a
// keyboard reaches every action a mouse can.
//
// **It lives in the bubble's top-right corner, not beside the bubble.** Beside
// it, the trigger was a flex sibling taking real width, so every bubble that
// could be acted on sat pushed in off the panel edge — and the reaction pills,
// which hang off the bubble's *own* edge, no longer lined up under it. The
// corner is also simply where a message's own actions belong. The caller makes
// the bubble the positioning context (`msg-menu-host`).
//
// **The items are data, not JSX** (`messageActions` in ConversationThreadView),
// for the same reason the app's are: M9d inserts Reply, M9f inserts Select, and
// a menu built out of conditional JSX would have to be re-read from scratch by
// each of them.
//
// `getActions` is a *function*, called when the menu opens rather than during
// render, because one of the entries expires: Edit is offered for fifteen
// minutes, and a list built at render time would make the menu's contents depend
// on when React last happened to redraw the bubble. Same reasoning as the app's
// `messageActions`, where the clock is passed in for exactly this reason.
//
// The panel is a `DrawerPopover` — portalled to `<body>` and positioned in
// viewport coordinates; see that file for why the drawer can't use the feed's
// page-coordinate portal.
export default function MessageMenu({
  getActions,
  /**
   * True when the trigger sits on your own bubble's accent fill, which needs
   * light dots on the fill's own colour rather than the ink palette. An
   * emoji-only message has no fill, so it takes the ink one even when it's
   * yours.
   */
  onFill,
  /**
   * Toggle an emoji on this message. **Omitted when reacting isn't available**
   * — a thread you can no longer send to — and the row is then left out
   * entirely rather than shown offering an action the server would 403. Same
   * line the app draws.
   */
  onReact,
  /** The emoji you've already used here, so a quick slot reads as active and
   * clicking it takes the reaction off. */
  reactedEmojis,
}) {
  const triggerRef = useRef(null);
  const [actions, setActions] = useState(null);
  // The full picker replaces the panel's contents rather than opening beside it:
  // one portal, one anchor, and no moment where two popovers are on screen
  // fighting over the same outside-click.
  const [full, setFull] = useState(false);
  const open = actions !== null;
  const showQuick = !!onReact;

  function close() {
    setActions(null);
    setFull(false);
  }

  function react(emoji) {
    close();
    onReact(emoji);
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close() : setActions(getActions()))}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Message options"
        // `msg-menu-trigger` owns when this is *visible* (index.css): hidden
        // until the bubble is hovered, and always visible on an input that
        // can't hover — a phone browser — where hiding it would make the whole
        // menu an invisible button nobody could find.
        //
        // Absolutely positioned in the bubble's top-right corner. It needs no
        // background of its own because the bubble *reserves* that corner
        // (`msg-menu-host` in index.css) on every device — text can't enter a
        // padding box, so the dots never have words behind them to mask.
        className={`msg-menu-trigger absolute right-1 top-1 z-10 flex h-6 w-6 items-center justify-center rounded-full transition ${
          onFill
            ? "text-white/70 hover:bg-white/25 hover:text-white"
            : "text-ink-faint hover:bg-accent-tint hover:text-accent-deep"
        }`}
      >
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
          className="h-4 w-4"
        >
          <circle cx="12" cy="5" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="12" cy="19" r="1.6" />
        </svg>
      </button>

      {open && (
        <DrawerPopover
          anchorRef={triggerRef}
          label="Message options"
          width={full ? PICKER_WIDTH : showQuick ? QUICK_WIDTH : MENU_WIDTH}
          height={
            full
              ? PICKER_HEIGHT
              : actions.length * ITEM_HEIGHT +
                (showQuick ? QUICK_HEIGHT : 0) +
                PANEL_PADDING
          }
          // The picker brings its own rounded, bordered chrome, so wrapping it
          // in the menu's would draw two frames around one popover.
          bare={full}
          onClose={close}
        >
          {full ? (
            <Suspense fallback={null}>
              <EmojiPickerPopover
                onPick={react}
                onClose={close}
                ignoreRef={triggerRef}
              />
            </Suspense>
          ) : (
            <>
              {showQuick && (
                <div className="flex items-center gap-0.5 border-b border-line px-1 pb-1">
                  {CHAT_QUICK_EMOJI.map((emoji) => {
                    const active = reactedEmojis?.has(emoji);
                    return (
                      <button
                        key={emoji}
                        type="button"
                        onClick={() => react(emoji)}
                        aria-pressed={!!active}
                        aria-label={
                          active
                            ? `Remove ${emoji} reaction`
                            : `React with ${emoji}`
                        }
                        className={`flex h-8 w-8 items-center justify-center rounded-full text-lg leading-none transition hover:scale-110 ${
                          active ? "bg-accent-tint" : "hover:bg-accent-tint"
                        }`}
                      >
                        <span aria-hidden="true">{emoji}</span>
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    onClick={() => setFull(true)}
                    aria-label="More emoji"
                    className="flex h-8 w-8 items-center justify-center rounded-full text-ink-faint transition hover:bg-accent-tint hover:text-accent-deep"
                  >
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
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </button>
                </div>
              )}
              {actions.map((action) => (
                <MenuItem
                  key={action.label}
                  danger={action.danger}
                  onClick={() => {
                    close();
                    action.onClick();
                  }}
                >
                  {action.label}
                </MenuItem>
              ))}
            </>
          )}
        </DrawerPopover>
      )}
    </>
  );
}

const MENU_WIDTH = 160;
/** Seven 32px slots (six emoji + `＋`), their gaps, and the panel's padding. */
const QUICK_WIDTH = 252;
const ITEM_HEIGHT = 36;
/** The quick-reaction row's height, including its divider. */
const QUICK_HEIGHT = 44;
const PANEL_PADDING = 8;
// Roughly what `emoji-picker-element` occupies — used only to keep it on screen.
const PICKER_WIDTH = 348;
const PICKER_HEIGHT = 400;
