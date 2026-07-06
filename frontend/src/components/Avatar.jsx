// A user's avatar. If they've uploaded one, show the (square) thumbnail the
// backend generated; otherwise fall back to a coloured circle with their
// initial.
//
// The fallback is derived from the user's `display_name` (the label the backend
// computes — real name, or email local-part until a name is set), so the same
// person's colour and initial stay stable across the app.

// A warm earth palette that lives in the same world as the surface — replacing
// the old bright primaries. Each maps to a --color-av-* token in index.css.
const COLORS = [
  "bg-av-clay",
  "bg-av-ochre",
  "bg-av-sage",
  "bg-av-teal",
  "bg-av-plum",
  "bg-av-moss",
];

function colorFor(seed) {
  let sum = 0;
  for (const ch of seed) sum += ch.charCodeAt(0);
  return COLORS[sum % COLORS.length];
}

export default function Avatar({ user, size = "md" }) {
  const sizes = {
    sm: "h-8 w-8 text-sm",
    md: "h-10 w-10 text-base",
    lg: "h-20 w-20 text-3xl",
  };
  const name = user?.display_name || "?";
  const initial = name.charAt(0).toUpperCase();

  if (user?.avatar_thumb) {
    return (
      <img
        src={user.avatar_thumb}
        alt=""
        aria-hidden="true"
        loading="lazy"
        className={`inline-block shrink-0 rounded-full object-cover ${sizes[size]}`}
      />
    );
  }

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${colorFor(
        name
      )} ${sizes[size]}`}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}
