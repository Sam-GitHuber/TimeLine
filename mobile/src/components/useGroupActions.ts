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

import { api } from '@/api';
import { useAuth } from '@/auth';

export function useGroupActions(groupId: number) {
  const { user: me } = useAuth();
  const queryClient = useQueryClient();

  const backToGroups = () => {
    queryClient.invalidateQueries({ queryKey: ['groups'] });
    router.replace('/groups');
  };

  const onError = (error: unknown) => {
    Alert.alert(
      'Couldn’t do that',
      error instanceof Error ? error.message : 'Something went wrong.'
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
    Alert.alert('Leave group?', 'You’ll stop seeing its timeline.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Leave', style: 'destructive', onPress: () => leaveMutation.mutate() },
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
