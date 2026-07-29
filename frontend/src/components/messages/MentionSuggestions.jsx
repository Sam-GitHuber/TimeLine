import Avatar from "../Avatar.jsx";

/**
 * The people offered while you type `@` (Phase 9b M8 on the phone, M9f here).
 *
 * Sits directly **above the composer**, between it and the transcript — the same
 * place the app puts it, and for a reason that survives the change of medium:
 * it's the nearest surface to the words being typed, and it's out of the way the
 * moment there's no `@` in progress. A strip, not a dialog: you're still writing,
 * and something that has to be dismissed would turn naming someone into a detour.
 *
 * Deliberately renders nothing when there's nobody to suggest, so a caller can
 * mount it unconditionally and let it decide. Same reason it takes the already
 * filtered list: matching is a string question that belongs in `mentions.js`
 * with its tests, not in a component.
 *
 * **`onMouseDown` is prevented on every chip**, which is the one thing this has
 * to do that the app's doesn't. A mouse press moves focus before the click
 * lands, so without it the textarea blurs, the caret is lost, and the name is
 * inserted into an input you then have to click back into. The pick itself still
 * happens on `click`, so a keyboard's Enter/Space works untouched.
 */
export default function MentionSuggestions({ people, onChoose }) {
  if (people.length === 0) return null;

  return (
    <div
      // A list of people, announced as one thing rather than as a run of loose
      // buttons appearing under a textarea.
      role="group"
      aria-label="Mention someone"
      className="mb-2 flex gap-1.5 overflow-x-auto border-b border-line pb-2"
    >
      {people.map((person) => (
        <button
          key={person.id}
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onChoose(person)}
          aria-label={`Mention ${person.display_name}`}
          className="flex shrink-0 items-center gap-1.5 rounded-full border border-line-strong bg-raised py-1 pl-1 pr-2.5 text-sm font-medium text-ink transition hover:border-accent hover:bg-accent-tint hover:text-accent-deep"
        >
          <Avatar user={person} size="xs" />
          <span className="max-w-40 truncate">{person.display_name}</span>
        </button>
      ))}
    </div>
  );
}
