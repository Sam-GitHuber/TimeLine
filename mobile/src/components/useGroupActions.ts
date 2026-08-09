/**
 * The confirm-and-run group actions shared by the group page's ⋯ menu (Phase 9
 * E3a): **leave** the group, and **delete** it (admin). Both are destructive and
 * navigate back to the Groups tab on success, so they live in one hook rather
 * than being re-implemented per call site.
 *
 * `leave` is `removeGroupMember(groupId, me)` — the same endpoint an admin uses
 * to remove someone, with your own id (see groups.md). The **last-admin
 * guardrail** is server-side: the sole admin leaving/deleting-nothing gets a 400,
 * whose message we surface rather than swallow, so the user learns they must
 * promote someone first.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Alert } from 'react-native';

import { api, serverMessage, WENT_WRONG } from '@/api';
import { useAuth } from '@/auth';
import { invalidateGroupMembership } from '@/groupCache';

/**
 * What a **leave** asks before it happens, wherever it's triggered from.
 *
 * Shared because there are two triggers for one action: this hook's ⋯ menu entry,
 * and the members roster's *Leave group* on your own row (#282), which is the
 * same `removeGroupMember` call. Two copies of the wording would drift, and the
 * roster's comment and `groups.md` both claim they're identical — a claim nothing
 * would have enforced.
 */
export const LEAVE_GROUP_CONFIRM = {
  title: 'Leave group?',
  message: 'You’ll stop seeing its timeline.',
  confirm: 'Leave',
} as const;

export function useGroupActions(groupId: number) {
  const { user: me } = useAuth();
  const queryClient = useQueryClient();

  const backToGroups = () => {
    // Both writes end your membership, so they refresh the home feed and the
    // personal calendar as well as the groups list — see `groupCache.ts` for
    // why leaving the feed alone leaves it offering posts the server refuses.
    invalidateGroupMembership(queryClient);
    router.replace('/groups');
  };

  const onError = (error: unknown) => {
    Alert.alert(
      'Couldn’t do that',
      serverMessage(error, WENT_WRONG)
    );
  };

  const leaveMutation = useMutation({
    mutationFn: () => {
      if (!me) throw new Error('Not signed in.');
      return api.removeGroupMember(groupId, me.pk);
    },
    onSuccess: backToGroups,
    onError,
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteGroup(groupId),
    onSuccess: backToGroups,
    onError,
  });

  const leave = () =>
    Alert.alert(LEAVE_GROUP_CONFIRM.title, LEAVE_GROUP_CONFIRM.message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: LEAVE_GROUP_CONFIRM.confirm,
        style: 'destructive',
        onPress: () => leaveMutation.mutate(),
      },
    ]);

  const remove = () =>
    Alert.alert(
      'Delete group?',
      'This deletes the group and all its posts for everyone. This can’t be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => deleteMutation.mutate() },
      ]
    );

  return { leave, remove };
}
