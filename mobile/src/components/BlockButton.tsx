/**
 * Block / unblock control on a person's profile action row. Ported from
 * `frontend/src/components/BlockButton.jsx`.
 *
 * Blocking is the strong, explicit cut: it severs any connection, stops messaging
 * both ways, hides your conversation from both of you, and bars re-connecting — so
 * we confirm first via `DisconnectWarningModal` (which also names any group chats
 * the block would drop you out of). Unblocking undoes none of that damage, so it
 * needs no warning.
 *
 * `isBlocked` is whether *you* have blocked them (from the profile payload's
 * `is_blocked`). App Review requires a working block, so this must be reachable
 * from any other person's profile.
 *
 * A rejected block used to be completely silent (issue #236): the warning modal
 * dismissed before the mutation was even fired, the mutation had no error path,
 * and nothing alerted — so a POST that never landed left the button still
 * reading "Block" and looked exactly like one that worked. You then believed
 * someone was blocked who could still message you and read your posts. This is
 * the one place in the app where a silently-failed write leaves a person with a
 * false belief about their own safety, so two things follow from it:
 *
 *   1. The write has to land before the modal dismisses. `mutateAsync` is
 *      awaited so the dialog stays up behind the alert and its confirm button
 *      becomes the retry.
 *   2. The alert states what is still true rather than repeating the server's
 *      words. `BlockView`'s only authored rejection is "You can't block
 *      yourself" — unreachable, since the button isn't rendered on your own
 *      profile — so every failure a real person hits here is a 404, a 500 or a
 *      dropped connection, none of which say the thing that matters. (Offline,
 *      React Native rejects with `TypeError: Network request failed`.)
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text } from 'react-native';

import { api } from '@/api';
import { invalidateConnectionChange } from '@/connectionCache';
import { DisconnectWarningModal } from './DisconnectWarningModal';
import { colors, fontSize, spacing } from '@/theme';

export function BlockButton({
  userId,
  displayName,
  isBlocked,
}: {
  userId: number;
  displayName: string;
  isBlocked: boolean;
}) {
  const queryClient = useQueryClient();
  const [showWarning, setShowWarning] = useState(false);

  const mutation = useMutation({
    mutationFn: () => (isBlocked ? api.unblockUser(userId) : api.blockUser(userId)),
    // A block deletes the `Connection` row outright ("Blocking severs any
    // connection" — `BlockView.post`), so it moves the visibility boundary just
    // as a disconnect does and refreshes the same set. Its own list used to omit
    // `['connections']`, leaving someone you'd just blocked listed as a
    // connection (#278), and every calendar and event key (#285).
    //
    // **Unblocking deliberately fires the same call, and it is a superset of
    // what that direction needs.** `BlockView.delete` only deletes the `Block`
    // row — it restores no connection, so `connected_user_ids` doesn't move and
    // the feed/calendar/event keys are a wasted refetch rather than a wrong one.
    // What unblocking does move is most of the rest: `is_blocked` on the profile
    // and the people lists, and the messaging surfaces, since
    // `_conversation_visible` hides a blocked pair's direct thread and lifting
    // the block brings it back. Splitting the two directions to save one refetch
    // on a rare, deliberate action would put the *block* path — the one where
    // being subtly wrong means believing someone is cut off who isn't (#236) —
    // at the mercy of a boolean prop. Not worth it; both directions are pinned
    // in `connectionCache.test.tsx`.
    onSuccess: () => invalidateConnectionChange(queryClient, userId),
  });

  // Like `PollTally`'s rollback, this leans on a deferral recorded in
  // `app/_layout.tsx`: with `onlineManager` left unwired to NetInfo, an offline
  // block *rejects*. Wire it and React Query's default `networkMode: 'online'`
  // would **pause** the mutation instead — `mutateAsync` never settles, so no
  // catch, no alert, and worse than the silence this fixes: `busy` stays true,
  // and the warning dialog refuses Cancel, backdrop and back while busy, so the
  // user is sealed inside it. The tripwire is invisible from either file alone.
  //
  // The wording is resolved at the attempt: a successful block flips `isBlocked`
  // underneath us, and the message must keep describing the action that failed.
  async function run() {
    const wording = isBlocked
      ? `Couldn’t unblock ${displayName} — they’re still blocked. Try again.`
      : `Couldn’t block ${displayName} — they’re not blocked. Try again.`;
    try {
      await mutation.mutateAsync();
      setShowWarning(false);
    } catch {
      Alert.alert(isBlocked ? 'Couldn’t unblock' : 'Couldn’t block', wording);
    }
  }

  function handlePress() {
    if (isBlocked) {
      run();
      return;
    }
    setShowWarning(true);
  }

  return (
    <>
      <Pressable
        onPress={handlePress}
        disabled={mutation.isPending}
        accessibilityRole="button"
        accessibilityLabel={isBlocked ? 'Unblock' : 'Block'}
        hitSlop={6}
        style={styles.trigger}
      >
        {mutation.isPending ? (
          <ActivityIndicator color={colors.inkFaint} size="small" />
        ) : (
          <Text style={styles.label}>{isBlocked ? 'Unblock' : 'Block'}</Text>
        )}
      </Pressable>

      {showWarning ? (
        <DisconnectWarningModal
          userId={userId}
          userName={displayName}
          action="block"
          busy={mutation.isPending}
          onConfirm={run}
          onCancel={() => setShowWarning(false)}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    justifyContent: 'center',
  },
  label: { fontSize: fontSize.sm, fontWeight: '600', color: colors.danger },
});
