/**
 * Follow / Following — ask to be told when this person posts (issue #382, app
 * half #383). The twin of the web's `FollowButton.jsx`, and deliberately not a
 * second interpretation of it.
 *
 * **The word is the user's, not the model's.** "Follow" is what people already
 * call this, so the UI says it — but it buys nothing and grants nothing. You can
 * already see every post this person writes, because you're connected, which is
 * the precondition the server checks before it will create the subscription at
 * all. All this toggle changes is whether their next post also lands in your
 * activity centre and buzzes your phone. In particular it does **not** touch the
 * feed: the timeline stays strictly reverse-chronological for everyone, followed
 * or not (docs/SHARED.md). Hence the rendering rule in `app/u/[userId].tsx` —
 * it appears *inside* the connected case, beside Message, never as a fifth
 * connection state and never on your own profile.
 *
 * **Off by default.** There is no follow-on-connect and no backfill, so this
 * reads "Follow" on every profile until someone presses it.
 *
 * A rejection alerts (issue #236). Without it a failed follow leaves a control
 * still reading "Follow" with nothing said, which looks exactly like a tap that
 * didn't register — so the natural response is to press it again, and the
 * natural belief afterwards is that you're being notified when you aren't.
 *
 * The alert is where the two clients legitimately differ. The web renders its
 * refusal inline under the button, and has to track whose profile it belongs to,
 * because `/u/:id` is one route that doesn't remount between people. This screen
 * is pushed fresh per profile *and* an `Alert` is modal and dismissed by hand,
 * so a message can't outlive the person it was about. Nothing to guard.
 *
 * Like every other write in the app, this leans on a deferral recorded in
 * `app/_layout.tsx`: with `onlineManager` left unwired to NetInfo, an offline tap
 * *rejects*, which is what runs the catch below. Wire it and React Query's
 * default `networkMode: 'online'` would **pause** the mutation instead —
 * `mutateAsync` never settles, so no catch, no alert, and the button sticks on
 * "Saving…" for good. The tripwire is invisible from either file alone.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Alert, Pressable, StyleSheet, Text } from 'react-native';

import { api, ApiError, serverMessage } from '@/api';
import { invalidateConnectionChange } from '@/connectionCache';
import { colors, fontSize, radius, spacing } from '@/theme';

export function FollowButton({
  userId,
  displayName,
  isFollowing,
}: {
  userId: number;
  displayName: string;
  isFollowing: boolean;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () =>
      isFollowing ? api.unfollowUser(userId) : api.followUser(userId),
    /**
     * **Just this profile, deliberately** — not `invalidateConnectionChange`.
     * That helper exists because a *connection* moves the visibility boundary a
     * dozen screens gate on; a follow moves nothing at all. `is_following` is
     * annotated on the profile payload and nowhere else (`UserListView` skips
     * it, so the people lists couldn't render this control anyway), which makes
     * `['user', userId]` the whole of what went stale. Firing the connection set
     * here would be seventeen refetches to repaint one word.
     *
     * The reverse direction *is* covered, and for free: ending a connection
     * deletes the subscription server-side, and `invalidateConnectionChange`
     * already names `['user', userId]` — so a disconnect repaints this toggle
     * back to "Follow" without either file knowing about the other.
     *
     * **The promise is returned, not fired and forgotten**, and that is the
     * whole of what keeps the label honest. React Query awaits whatever
     * `onSuccess` returns before it clears `isPending`; drop the promise and
     * the button leaves "Saving…" the instant the POST answers — while the
     * profile query is still refetching and `isFollowing` is still the stale
     * `false` it was pressed with. The label computed from it therefore reads
     * **"Follow"** again for the length of a whole GET, which is precisely the
     * "the tap didn't register" appearance the docstring above says this
     * control exists to avoid, and it invites a second press. Held, the
     * sequence is Follow → Saving… → Following, with nothing in between.
     */
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['user', userId] }),
  });

  /**
   * Whether this control is still on screen when the write comes back.
   *
   * A press followed by Back pops the profile, but nothing about unmounting
   * touches the promise `run` is sitting on — so without this, tapping Follow
   * and leaving throws a modal *"Couldn't follow Priya"* over the feed, or over
   * whoever's profile you went to next. The web twin has the same exposure and
   * answers it differently (it tracks whose profile the inline message belongs
   * to, because `/u/:id` doesn't remount between people); here the screen really
   * is gone, and a refusal has nowhere left to be reported. `app/activity.tsx`
   * guards its own late-landing write the same way.
   */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * The wording is resolved at the attempt and held as a local, because a
   * success flips `isFollowing` underneath us and the message must keep
   * describing the action that actually failed — `BlockButton`'s rule.
   *
   * Per state rather than one "something went wrong": which of the two things
   * didn't work, and what is therefore still true, is the whole of what the
   * reader needs.
   */
  async function run() {
    const from = isFollowing;
    const fallback = from
      ? `Couldn’t unfollow ${displayName} — you’re still being notified about their posts.`
      : `Couldn’t follow ${displayName} — you won’t be notified about their posts.`;
    try {
      await mutation.mutateAsync();
    } catch (err) {
      /**
       * **A refusal here is news about the relationship, so the screen has to
       * be repainted as well as apologised to.**
       *
       * This is the one place the "a follow moves nothing" rule above turns
       * over. Every answer `FollowView` can give a real person is the server
       * saying the relationship this screen is drawn from has moved underneath
       * it: 400 because you're no longer connected, 403 because a block now
       * stands between you (which severs the connection too), 404 because the
       * account is gone. Without this, dismissing the alert leaves a header
       * still reading *Connected*, a Message button, and their whole posts wall
       * — every one of which the server would now refuse. The alert would have
       * told them the connection is gone and the screen underneath would be
       * contradicting it.
       *
       * So *this* failure earns the wide `invalidateConnectionChange`, for
       * exactly the reason the success path doesn't: the visibility boundary
       * really did move. A 5xx or a dropped connection is not entitled to say
       * so — it says nothing about the relationship at all — so it repaints
       * nothing and only apologises.
       */
      if (
        err instanceof ApiError &&
        (err.status === 400 || err.status === 403 || err.status === 404)
      ) {
        invalidateConnectionChange(queryClient, userId);
      }
      // Nowhere to report it if the screen has gone — see `mounted` above.
      if (!mounted.current) return;
      // The server's own words win where it has any: `FollowView` authors
      // sentences written for a person ("You can only follow people you're
      // connected with.", when they disconnected while this screen was open),
      // which say more than any fallback could. Offline, React Native rejects
      // with `TypeError: Network request failed`, which says nothing worth
      // showing — that's what the fallback is for.
      Alert.alert(
        from ? 'Couldn’t unfollow' : 'Couldn’t follow',
        serverMessage(err, fallback)
      );
    }
  }

  // "Saving…" rather than "Following…"/"Unfollowing…" (#322's second finding:
  // a control that looks dead for the round trip). It's the app's established
  // pending label, and — the reason it wins here specifically — "Following…" is
  // one ellipsis away from "Following", the resting label for the state the tap
  // is trying to reach. A pending label that reads as the finished state is no
  // pending label at all.
  const label = mutation.isPending
    ? 'Saving…'
    : isFollowing
      ? 'Following'
      : 'Follow';

  return (
    <Pressable
      onPress={run}
      disabled={mutation.isPending}
      accessibilityRole="button"
      // The visible label plus the name, as `ConnectButton` does — so speaking
      // what's on screen still reaches the control. What a press *does* goes in
      // the hint, where it belongs, since "Following" names a state.
      accessibilityLabel={`${isFollowing ? 'Following' : 'Follow'} ${displayName}`}
      accessibilityHint={
        isFollowing
          ? 'Stops notifying you when they post'
          : 'Notifies you when they post'
      }
      // `busy` is the announcement of the pending state — the visible label
      // changes to "Saving…" but the accessibility label deliberately doesn't
      // (it would stop naming the person mid-write), so this is what tells a
      // screen reader the tap landed and something is happening.
      accessibilityState={{
        selected: isFollowing,
        disabled: mutation.isPending,
        busy: mutation.isPending,
      }}
      style={({ pressed }) => [
        styles.button,
        // Filled while it's an invitation to act, quiet once it's a state
        // you're already in — the same primary/ghost split `ConnectButton`
        // uses, and the same one the web twin uses, so the two clients look
        // alike. Note what that actually produces in the only state this row
        // exists in: `ConnectButton` is ghost ("Connected"), `MessageButton`
        // has no variants and is always accent, so an unfollowed profile shows
        // *two* accent pills. That's the web's row too, deliberately — Message
        // and Follow are both things to do, and demoting either would make the
        // clients diverge on nothing more than taste.
        isFollowing ? styles.ghost : styles.filled,
        (pressed || mutation.isPending) && styles.pressed,
      ]}
    >
      <Text style={[styles.label, isFollowing ? styles.ghostLabel : styles.filledLabel]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Matches ConnectButton's `md` and MessageButton, so the row sits as a set.
  button: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filled: { backgroundColor: colors.accent },
  ghost: {
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.raised,
  },
  pressed: { opacity: 0.7 },
  label: { fontSize: fontSize.sm, fontWeight: '600' },
  filledLabel: { color: '#ffffff' },
  ghostLabel: { color: colors.ink },
});
