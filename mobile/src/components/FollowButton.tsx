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
import { Alert, Pressable, StyleSheet, Text } from 'react-native';

import { api, serverMessage } from '@/api';
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
     */
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user', userId] });
    },
  });

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
        // Filled while it's an invitation to act, quiet once it's a state you're
        // already in — the same primary/ghost split `ConnectButton` uses, so the
        // three controls on this row read as one set.
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
