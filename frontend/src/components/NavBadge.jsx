// The nav "you have something waiting" indicator, shared by the Messages item
// and the activity-centre bell. On a phone each item is just an icon, so the
// count wouldn't have room — we show a small accent dot pinned to the icon's
// corner instead. From `sm` up (labels visible) it becomes the count pill.
//
// Both forms are *absolutely* positioned, deliberately. The nav row is a tight
// fit inside the 640px column, and an inline count pill used to widen its item
// enough to push the row past the column's right edge as soon as a count
// appeared — taking the avatar and its dropdown outside the frame with it.
// Pinning the badge to the item's corner costs zero layout width, so the row's
// width no longer depends on whether you have anything unread.
//
// The count itself reaches screen readers via each item's aria-label, so both
// forms here are decorative (aria-hidden). Callers must be `relative`.
//
// Counts are capped at "99+": because the pill is pinned to the item's right
// edge it grows *leftwards*, over the item's own label, so an uncapped
// three-digit count would bury the word it's badging. Screen readers still get
// the exact number from the aria-label.
export default function NavBadge({ count }) {
  return (
    <>
      <span
        aria-hidden="true"
        className="absolute right-1 top-1 h-2 w-2 rounded-full bg-accent ring-2 ring-surface sm:hidden"
      />
      <span
        aria-hidden="true"
        className="absolute -right-1 -top-1 hidden min-w-[18px] items-center justify-center rounded-full bg-accent px-1.5 text-[0.68rem] font-bold tabular-nums text-white ring-2 ring-surface sm:inline-flex"
      >
        {count > 99 ? "99+" : count}
      </span>
    </>
  );
}
