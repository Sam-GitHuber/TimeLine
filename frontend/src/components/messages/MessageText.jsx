import { useMemo } from "react";
import { parseMessageText } from "../../messageText.js";

// A message body, drawn from the segments `messageText.js` finds in it (Phase
// 9b M9b): plain runs, styled runs, and links you can actually click.
//
// 🔒 A link is an `<a>` and nothing more — nothing is fetched from the target
// and nothing is rendered from it. That's the line between linkifying (this)
// and link *previews*, which stay on the phase's "not building" list precisely
// because they'd have the server fetch every URL anyone pastes. `noreferrer`
// also keeps the drawer from leaking who followed what to the other end.
//
// The fast path matters: an ordinary message is one unmarked segment, so it
// renders as one text node rather than a map over an array of one.
export default function MessageText({ text, mine, large }) {
  const segments = useMemo(() => parseMessageText(text), [text]);

  const body =
    segments.length === 1 && segments[0].kind === "text" && !segments[0].marks
      ? segments[0].text
      : segments.map((segment, index) =>
          segment.kind === "link" ? (
            <a
              key={`link-${index}`}
              href={segment.url}
              target="_blank"
              rel="noreferrer"
              // Stop the click bubbling into the bubble: a link is its own
              // action, and on a message row that also opens a menu the two
              // would fight.
              onClick={(event) => event.stopPropagation()}
              className={`underline underline-offset-2 ${
                mine ? "decoration-white/60" : "decoration-accent/60"
              } ${markClass(segment.marks)}`}
            >
              {segment.text}
            </a>
          ) : (
            <span key={`text-${index}`} className={markClass(segment.marks)}>
              {segment.text}
            </span>
          )
        );

  if (large) {
    // One to three emoji and nothing else: no bubble, just the glyphs, big.
    return <p className="py-0.5 text-[2.75rem] leading-tight">{body}</p>;
  }
  return (
    <p className="whitespace-pre-wrap break-words text-[0.95rem]">{body}</p>
  );
}

// The four marks the parser can put on a run. `mono` gets a tint rather than a
// box so it reads as code inside a coloured bubble without fighting it.
function markClass(marks) {
  if (!marks || marks.length === 0) return "";
  return [
    marks.includes("bold") ? "font-semibold" : "",
    marks.includes("italic") ? "italic" : "",
    marks.includes("strike") ? "line-through" : "",
    marks.includes("mono") ? "font-mono text-[0.9em]" : "",
  ]
    .filter(Boolean)
    .join(" ");
}
