import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { serverMessage } from "../errors.js";

// Follow / Following — ask to be told when this person posts (issue #382).
//
// **The word is the user's, not the model's.** "Follow" is what people already
// call this and nobody asks for it by another name, so the UI says it — but it
// buys nothing and grants nothing. You can already see every post this person
// writes, because you're connected, which is the precondition the server checks
// before it will create the subscription at all. All this toggle changes is
// whether their next post also lands in your activity centre and buzzes your
// phone. In particular it does **not** touch the feed: the timeline stays
// strictly reverse-chronological for everyone, followed or not (docs/SHARED.md).
// Hence the rendering rule in `ProfilePage`: it appears *inside* the connected
// case, beside Message, never as a fifth connection state.
//
// **Off by default.** There is no follow-on-connect and no backfill, so this
// reads "Follow" on every profile until someone presses it.
//
// A rejection is reported in place, under the button (#236). Without it a
// failed follow leaves a control still reading "Follow" with nothing said, which
// looks exactly like a click that didn't register — so the natural response is
// to press it again, and the natural belief afterwards is that you're being
// notified when you aren't.
export default function FollowButton({ userId, displayName, isFollowing }) {
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState(null);

  const mutation = useMutation({
    mutationFn: () =>
      isFollowing ? api.unfollowUser(userId) : api.followUser(userId),
    // **Just this profile, deliberately** — not `invalidateConnectionChange`.
    // That helper exists because a *connection* moves the visibility boundary a
    // dozen screens gate on; a follow moves nothing. `is_following` is
    // annotated on the profile payload and nowhere else (the people lists don't
    // render this control), so the profile query is the whole of what went
    // stale. Refetching the feed, the calendars and the group timelines here
    // would be a dozen requests to repaint a word on one button.
    //
    // The reverse direction *is* covered, and for free: ending a connection
    // deletes the subscription server-side, and `invalidateConnectionChange`
    // already refreshes `["user", userId]` — so a disconnect repaints this
    // toggle back to "Follow" without either file knowing about the other.
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["user", userId] });
    },
  });

  // Retire the message once the server's own answer moves to the one the
  // attempt was reaching for: the request landed after all and only its
  // response was lost, so "couldn't follow" would be sitting under a button
  // that now reads "Following". Judged against what was recorded *at the
  // attempt* rather than against when the refetch arrives, so a sync landing in
  // the same render batch as the rejection can't swallow the message before
  // it's painted (the trap #231 describes). Render-phase, like `BlockButton`'s
  // equivalent — no effect, no extra paint.
  if (failure && isFollowing !== failure.from) setFailure(null);

  // Resolved at the attempt and held as a string: a success flips `isFollowing`
  // underneath us, and the message must keep describing the action that
  // actually failed. Per state rather than one "something went wrong", because
  // which of the two things didn't work is the whole of what the reader needs.
  async function run() {
    const from = isFollowing;
    const fallback = from
      ? `Couldn’t unfollow ${displayName} — you’re still being notified about their posts.`
      : `Couldn’t follow ${displayName} — you won’t be notified about their posts.`;
    setFailure(null);
    try {
      await mutation.mutateAsync();
    } catch (err) {
      // The server's own words win where it has any: `FollowView` authors
      // sentences written for a person ("You can only follow people you're
      // connected with.", when they disconnected while this page was open),
      // which say more than any fallback could.
      setFailure({ text: serverMessage(err, fallback), from });
    }
  }

  return (
    // A column so the message stacks under the button rather than competing
    // with it for width — this sits in a profile's action row, a horizontal
    // flex container. A span, not a div, to match the controls beside it.
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={run}
        disabled={mutation.isPending}
        className={`btn btn-sm ${isFollowing ? "btn-ghost" : "btn-primary"}`}
        title={
          isFollowing
            ? "You’re notified when they post — click to stop"
            : "Get notified when they post"
        }
      >
        {isFollowing ? "Following" : "Follow"}
      </button>
      {failure && (
        <span
          role="alert"
          className="max-w-56 text-right text-xs leading-snug text-red-600"
        >
          {failure.text}
        </span>
      )}
    </span>
  );
}
