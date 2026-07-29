/**
 * Surgical writes into the transcript's cached pages (Phase 9b M9c).
 *
 * A port of the two helpers that live in the app's thread screen, kept in their
 * own module here because the web's `ConversationThreadView` is already the
 * biggest file in `components/messages/` and these are pure functions of
 * `(cache, message) → cache` with nothing React about them.
 *
 * Both exist for the same reason: an invalidate-and-refetch is a round trip, and
 * a round trip is a window in which the transcript shows the wrong thing.
 */

/**
 * Put an accepted message into a cached list, if it isn't there already.
 *
 * Bridges the gap between "the POST returned" and "the refetch has landed": for
 * that second or two the outbox entry is gone and the poll hasn't run, so
 * without this the bubble you just watched appear would blink out and back.
 *
 * `newestFirst` is which end "newest" is at. The transcript reads `?order=desc`
 * so it can page lazily (M9b), so it passes true; M9d's reply strand reads a
 * whole short strand in the endpoint's default oldest-first order and will pass
 * false. Passing it beats inferring from the data, which would be a guess that
 * reads correctly right up until a one-message list.
 *
 * The guard matters — a poll can land *between* the response and this write, so
 * the message may already be present, and inserting blind would show it twice.
 */
export function insertMessage(data, message, { newestFirst }) {
  if (!data?.pages?.length) return data;
  if (data.pages.some((page) => page.results.some((m) => m.id === message.id))) {
    return data;
  }
  const target = newestFirst ? 0 : data.pages.length - 1;
  const pages = data.pages.map((page, index) =>
    index === target
      ? {
          ...page,
          results: newestFirst
            ? [message, ...page.results]
            : [...page.results, message],
        }
      : page
  );
  return { ...data, pages };
}

/**
 * Write a message's fresh reaction summary into the cached pages.
 *
 * The toggle endpoint answers with the target's whole summary, so there's no
 * need to refetch a page of messages to show a reaction that has already been
 * decided — and refetching would mean a visible delay on a one-click gesture.
 *
 * 🔒 **There is deliberately no optimistic write here** (M2's fifth decision).
 * Simulating the toggle locally means a second copy of rules the server owns —
 * the per-target emoji cap, emoji validation, the count-then-emoji ordering —
 * which would drift and show a pill that then vanishes. The round trip is one
 * request against an already-open drawer.
 */
export function patchReactions(data, messageId, reactions) {
  if (!data?.pages) return data;
  return {
    ...data,
    pages: data.pages.map((page) =>
      // Rebuild only the page holding the message, so unrelated pages keep their
      // identity and don't re-render the whole thread on every reaction.
      page.results.some((m) => m.id === messageId)
        ? {
            ...page,
            results: page.results.map((m) =>
              m.id === messageId ? { ...m, reactions } : m
            ),
          }
        : page
    ),
  };
}
