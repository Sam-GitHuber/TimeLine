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
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';

import { api } from '@/api';
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
    onSuccess: () => {
      // A block/unblock changes connection state, feeds, and messaging surfaces —
      // invalidate them all, exactly as the web BlockButton does.
      for (const key of [
        ['user', userId],
        ['users'],
        ['feed'],
        ['conversations'],
        ['unreadMessages'],
        ['connectionRequests'],
      ]) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });

  function handlePress() {
    if (isBlocked) {
      mutation.mutate();
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
          onConfirm={() => {
            setShowWarning(false);
            mutation.mutate();
          }}
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
