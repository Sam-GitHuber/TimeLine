// A placeholder avatar: a coloured circle with the user's initial.
// Real profile photos arrive in Phase 4; for the wireframe this stands in.

// Deterministically pick a colour from the username so each person keeps the
// same avatar colour across the app.
const COLORS = [
  "bg-rose-500",
  "bg-amber-500",
  "bg-emerald-500",
  "bg-sky-500",
  "bg-violet-500",
  "bg-fuchsia-500",
];

function colorFor(username) {
  let sum = 0;
  for (const ch of username) sum += ch.charCodeAt(0);
  return COLORS[sum % COLORS.length];
}

export default function Avatar({ user, size = "md" }) {
  const sizes = {
    sm: "h-8 w-8 text-sm",
    md: "h-10 w-10 text-base",
    lg: "h-20 w-20 text-3xl",
  };
  const initial = user.displayName.charAt(0).toUpperCase();

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${colorFor(
        user.username
      )} ${sizes[size]}`}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}
