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
//
// `mentions` (M9f) are the display names this message's mention ids resolved to
// — the caller does the resolving, because it's the screen that holds the
// participants. Empty is the ordinary case and costs the parser nothing.
export default function MessageText({ text, mine, large, mentions }) {
  /**
   * Split once per message, not once per render.
   *
   * Ordinary text parses in microseconds, so this isn't about the common case —
   * it's about the worst one. The scan asks "does a run close here?" at each
   * delimiter it could open at, which is quadratic on a string full of openers
   * that never close (`*a *a *a …`). At the 5000-character message cap that's
   * tens of milliseconds, and a transcript re-renders on every poll, every
   * keystroke in the composer and every scroll — so an unmemoised parse turns
   * one awkward message into a permanently janky thread.
   */
  const segments = useMemo(
    () => parseMessageText(text, { mentions }),
    [text, mentions]
  );

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
          ) : segment.kind === "mention" ? (
            // Weighted, not underlined or clickable (M9f, matching the app): a
            // mention is a fact about who the message is *for*, and there's
            // nowhere useful to send someone who clicks it — the person's
            // profile is a link away in the header, and a link inside a
            // selectable, quotable message body is one more thing to fight with
            // the ⋯ menu and select mode over the same click.
            <span
              key={`mention-${index}`}
              className={`font-bold ${mine ? "text-white" : "text-accent-deep"} ${markClass(
                segment.marks
              )}`}
            >
              {segment.text}
            </span>
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
