import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import LoadMoreButton from "../LoadMoreButton.jsx";
import MentionSuggestions from "./MentionSuggestions.jsx";
import MessageBubble from "./MessageBubble.jsx";
import { api, MESSAGE_POLL_MS } from "../../api.js";
import { useFetchAllPages } from "../../hooks.js";
import { useMentions } from "../../mentions.js";

export function threadQueryKey(conversationId, rootId) {
  return ["thread", conversationId, rootId];
}

/**
 * A reply strand — the root message, every reply hanging off it, and a composer
 * that sends straight back into it (Phase 9b M3 on the phone, M9d here).
 *
 * **Every route to a reply comes through here**, whether you clicked "3 replies"
 * on a root, clicked a reply's quote, or hit Reply on a message with no replies
 * at all — the last of those opens a strand one bubble long, on purpose. You
 * reply *inside* the conversation you're joining, with the thing you're
 * answering on screen while you write it. The alternative (aim the transcript's
 * composer at a message and show a quote bar above it) was built on the phone
 * first and replaced: it shows you the one message you're answering and none of
 * the exchange around it, which is the same limitation that made a
 * collapsed-quote-only design wrong.
 *
 * **It takes the panel, where the app blurs the transcript behind it.** A first
 * cut of M9d did put the strand *beside* the transcript, widening the drawer
 * from 400px to 740 on a big window so both could be read at once, and it was
 * rejected on sight: a drawer that grows to half the window stops being a
 * companion to the timeline and becomes a takeover, which is the one trade this
 * panel is shaped not to make. So the strand covers the transcript at every
 * width — closer to the app than the widened version was, and with no breakpoint
 * to reason about.
 *
 * The transcript is **hidden rather than unmounted** (`ConversationThreadView`),
 * so the draft, an edit in progress, the latched unread divider and the poll all
 * survive a trip into a strand — M3 settled that replying must never disturb an
 * edit, and that has to hold when the strand is what's on screen.
 *
 * **It does carry the ⋯ menu, unlike the app's strand.** The app leaves the menu
 * out because its strand is a `Modal` and the menu is a `Modal`, and presenting
 * one from inside the other is an iOS trap — a constraint the web hasn't got
 * (`DrawerPopover` portals to `<body>` and anchors in viewport coordinates). The
 * menu here is deliberately one item shorter than the transcript's: **no Edit**.
 * Editing needs a composer mode, this composer already has a job, and a second
 * one would be the "two things fighting for one input" M3 settled against — the
 * transcript keeps Edit, and closing the strand is one click.
 *
 * **A missing root is a real state, not a loading one.** The strand is fetched
 * through the same interval-clipped endpoint as the transcript, so a member who
 * was out of the chat when the root was sent gets the replies they're entitled
 * to and no head. That says so in words rather than erroring, because nothing
 * has gone wrong.
 */
export default function MessageStrandPanel({
  conversationId,
  /** The strand's head — what the transcript's branch and quotes link to. */
  rootId,
  /**
   * The message a reply will answer. The root when you got here by browsing;
   * **Reply** passes the message you actually clicked, so a reply to a reply
   * quotes the person you meant rather than whoever started the strand.
   */
  replyToId,
  meId,
  isGroup,
  canSend,
  /**
   * Who can be named with `@` in here, and what everyone's name is (M9f) — the
   * same two the transcript's composer takes. A strand is where a group's
   * side-conversations happen, so it's if anything the *more* likely place to
   * name someone; leaving the picker out of one of the two composers would be
   * the sort of half-finished seam M9 exists to close.
   */
  mentionable = [],
  mentionNames,
  /** Aim the composer at a different message in this strand — the menu's Reply. */
  onAimAt,
  /**
   * Replies to this strand still in the caller's outbox (M9c), already dressed
   * as messages. Rendered after the loaded ones, so a reply appears the instant
   * you send it and a failed one stays put with somewhere to act on it — rather
   * than existing only in the transcript, which isn't on screen while you're in
   * here.
   */
  outgoing = [],
  /** The tick/clock for a bubble. The caller owns it; see the thread view. */
  statusFor,
  /** Server ids that arrived by your own sending — they skip the animation. */
  justSent,
  getActions,
  onReact,
  onSend,
  onRetry,
  onDiscard,
  onClose,
}) {
  const [text, setText] = useState("");
  const inputRef = useRef(null);
  const bottomRef = useRef(null);
  const mentions = useMentions({ people: mentionable, text, setText, inputRef });

  /**
   * Polled like the transcript, so a reply someone else sends while you're
   * reading the strand appears in it rather than only in the transcript behind it.
   *
   * **Paged, and every page pulled** — where the transcript pages lazily. That's
   * the difference between the two views rather than an inconsistency: a
   * transcript is unbounded and grows forever, so it reads `?order=desc` and
   * pages backwards as you scroll; a strand is one exchange inside it, bounded
   * by how much anyone says in reply to a single message. Reading only page one
   * would cut a busy strand off at its *oldest* twenty (they come oldest-first),
   * hiding the newest replies and, worse, the one you just sent from the
   * composer right there — while the root's count went on climbing past what the
   * strand showed, with nothing on screen to explain it.
   */
  const threadQuery = useInfiniteQuery({
    queryKey: threadQueryKey(conversationId, rootId),
    queryFn: ({ pageParam }) =>
      pageParam ? api.getPage(pageParam) : api.getThread(conversationId, rootId),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
    refetchInterval: MESSAGE_POLL_MS,
  });
  useFetchAllPages(threadQuery);

  const loaded =
    threadQuery.data?.pages.flatMap((page) => page.results) ?? [];
  // Unsent replies go last: one the server hasn't accepted is by definition
  // newer than every reply that has.
  const messages = [...loaded, ...outgoing];
  /**
   * Quotes resolve against the strand's own messages and nothing else — every
   * reply in here answers the root or another reply in here, by construction
   * (`thread_root` is derived one level deep). A miss therefore means the
   * genuine thing: the viewer was clipped out of that message.
   */
  const byId = new Map(loaded.map((m) => [m.id, m]));
  const root = byId.get(rootId);
  const target = replyToId ?? rootId;
  // Named above the composer only when it isn't the head of the strand —
  // otherwise the label would restate the message at the top of the panel.
  const answering = target === rootId ? undefined : byId.get(target);

  // Oldest-first, so keep the newest reply in view as pages land and as replies
  // arrive. Without this a strand longer than the panel opens at the root and
  // the reply you just sent is off the bottom. `?.` because jsdom has no layout.
  const shown = messages.length;
  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ block: "end" });
  }, [shown]);

  // Opened deliberately, from a click, so the composer takes focus — unlike the
  // phone, where the same move drags a keyboard over half the screen and so is
  // reserved for the route that came from Reply.
  useEffect(() => {
    inputRef.current?.focus();
  }, [rootId]);

  function handleSubmit(event) {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    /**
     * Cleared on dispatch, not on success (M9c). It used to be held until the
     * send resolved so a failure left the words in the box — but the reply is a
     * bubble in the strand the moment you hit Send, and a failure turns *that*
     * into a failed bubble with Retry beside it. Keeping the text here as well
     * would show one message twice and make it possible to send it twice.
     */
    // Reconciled against what's actually being sent (M9f): pick Ada, delete her
    // name again, and no id goes with the reply — see `mentionIdsIn`.
    const mentionIds = mentions.idsFor(value);
    mentions.reset();
    setText("");
    // Whichever message got you here. The server flattens it into this strand
    // either way, so naming the real target costs nothing and keeps the quote
    // honest about who you answered.
    onSend(value, target, mentionIds);
  }

  return (
    <section
      aria-label="Reply thread"
      // Escape leaves the strand rather than closing the drawer — the nearer
      // thing wins, the same call the transcript's composer already makes for
      // edit mode. Losing the whole panel, and with it the sight of the draft
      // and the edit this strand is hidden *over*, because you wanted to leave a
      // thread would be a surprise, and Escape is the key anyone tries first.
      // `stopPropagation` is what keeps it from reaching the drawer's own
      // document-level handler (`MessagesDrawer`).
      //
      // On the section rather than the composer so it works wherever focus is in
      // here — the composer takes it on open, but a click on a bubble's ⋯ or on
      // Close moves it.
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      className="flex min-w-0 flex-1 flex-col bg-surface"
    >
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <h2 className="font-display text-sm font-bold -tracking-[0.02em] text-ink">
          Thread
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full px-2 py-1 text-xs font-medium text-ink-faint transition hover:bg-accent-tint hover:text-accent-deep"
        >
          Close
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {threadQuery.isLoading ? (
          <p className="py-8 text-center text-sm text-ink-faint">Loading…</p>
        ) : (
          <>
            {/* Only when the root itself is clipped out — the replies below are
                ones this viewer *is* entitled to, so the strand is genuinely
                headless rather than empty. Different wording from a quote's
                "Original message unavailable" on purpose: on a whole strand that
                phrasing reads as an error, and these are two different things to
                tell someone. */}
            {!root && !threadQuery.isError && (
              <p className="mb-2 text-center text-xs italic text-ink-faint">
                The start of this thread isn’t available to you
              </p>
            )}
            {/* Only claim the strand is clipped when we actually heard back. A
                failed fetch is a different thing entirely, and telling someone
                they aren't entitled to a message when the network merely dropped
                devalues the message where it's true. */}
            {threadQuery.isError && (
              <p className="py-8 text-center text-sm text-ink-faint">
                Couldn’t load this thread. Close and try again.
              </p>
            )}
            <ul className="flex flex-col">
              {messages.map((message) => {
                const status = statusFor?.(message);
                // Retry and Discard belong to a reply the server hasn't taken
                // yet, and the status says so — `sending` and `failed` are the
                // outbox's two states, where anything loaded is `sent`, `read`
                // or nothing at all. Asking the status beats testing the id's
                // sign: the negative temp id is the outbox's own business.
                const unsent = status === "sending" || status === "failed";
                return (
                  <MessageBubble
                    key={`m-${message.id}`}
                    message={message}
                    mine={message.sender.id === meId}
                    // Every bubble in here is attributed in a group, runs
                    // included: the strand is short and read out of its
                    // chronological context, so "who said this" is worth the
                    // repetition.
                    showSender={isGroup && message.sender.id !== meId}
                    quoted={
                      message.reply_to ? byId.get(message.reply_to.id) : undefined
                    }
                    mentionNames={mentionNames}
                    // No `onOpenThread`: you're already in the strand, and there
                    // is nowhere further to go. The quote renders inert.
                    status={status}
                    meId={meId}
                    animate={!justSent?.has(message.id)}
                    getActions={unsent ? undefined : getActions}
                    // Bound here rather than by the caller, which doesn't know
                    // which bubble is being reacted to — the transcript binds
                    // the same way in its own map.
                    onReact={
                      onReact ? (emoji) => onReact(message.id, emoji) : undefined
                    }
                    onRetry={() => onRetry?.(message)}
                    onDiscard={() => onDiscard?.(message)}
                  />
                );
              })}
            </ul>
            {/* The scroll target, and the reason it's an element rather than a
                `scrollTop` write: the panel isn't `column-reverse` (a strand is
                short and reads top-down from its root), so there's no bottom
                origin to lean on. */}
            <div ref={bottomRef} />
            {/* Belt and braces for the every-page effect above: if a fetch
                fails, this is a way to ask again rather than a strand silently
                missing its newest replies. Renders nothing once there's no next
                page. */}
            <LoadMoreButton query={threadQuery} />
          </>
        )}
      </div>

      <div className="border-t border-line px-3 py-2">
        {canSend ? (
          <form onSubmit={handleSubmit}>
            {answering && (
              <p className="mb-1 flex items-center gap-1 truncate px-1 text-[0.7rem] font-semibold text-ink-soft">
                <span className="truncate">
                  Replying to {answering.sender.display_name}
                </span>
                {/* Aiming back at the root is the way out of a target you picked
                    by accident — without it the only escape is closing the
                    strand and opening it again. */}
                <button
                  type="button"
                  onClick={() => onAimAt?.(rootId)}
                  aria-label="Reply to the thread instead"
                  className="shrink-0 rounded-full px-1 text-ink-faint transition hover:text-ink"
                >
                  ✕
                </button>
              </p>
            )}
            {/* Who you might be naming (M9f), immediately above the input —
                nearest the words being typed, and gone the moment there's no
                `@` in progress. */}
            <MentionSuggestions
              people={mentions.suggestions}
              onChoose={mentions.choose}
            />
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={text}
                onChange={(e) =>
                  mentions.onChange(e.target.value, e.target.selectionStart)
                }
                // Where the caret is, which is what decides whether you're
                // half-way through typing an `@name` *right now*.
                onSelect={(e) => mentions.onCaretMove(e.target.selectionStart)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSubmit(e);
                  }
                }}
                rows={1}
                placeholder="Reply to thread…"
                aria-label="Reply to thread"
                className="max-h-24 flex-1 resize-none rounded-2xl border border-line-strong bg-raised px-3 py-2 text-sm text-ink transition placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-tint"
              />
              {/* Never disabled by a send in flight: each reply gets its own
                  outbox entry, so a quick second one doesn't wait on the first.
                  And no error line under here — a reply that fails says so on
                  the bubble it failed as, which is the only place that can tell
                  you *which* of two replies fell over. */}
              <button
                type="submit"
                disabled={!text.trim()}
                className="btn btn-primary btn-sm mb-0.5"
              >
                Send
              </button>
            </div>
          </form>
        ) : (
          <p className="py-1 text-center text-xs text-ink-faint">
            You can’t send messages in this conversation.
          </p>
        )}
      </div>
    </section>
  );
}
