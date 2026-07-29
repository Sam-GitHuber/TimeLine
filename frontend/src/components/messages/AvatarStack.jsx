import Avatar from "../Avatar.jsx";

// A group thread's header identity: overlapping avatars (capped so a big
// group doesn't blow out the header) with a ring so they read as a stack
// rather than a row.
export default function AvatarStack({ participants, max = 4 }) {
  const shown = participants.slice(0, max);
  return (
    <div className="flex shrink-0 -space-x-2.5">
      {shown.map((person) => (
        <span key={person.id} className="rounded-full ring-2 ring-surface">
          <Avatar user={person} size="sm" />
        </span>
      ))}
    </div>
  );
}
