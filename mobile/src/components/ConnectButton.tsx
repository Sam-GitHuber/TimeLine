/**
 * The connection control — a four-state button reflecting the private, mutual
 * connection flow. Ported from `frontend/src/components/ConnectButton.jsx`; the
 * state machine and the disconnect-warning routing match the web exactly so the
 * two clients behave identically.
 *
 *   none      → "Connect"   → sends a request           → api.connect
 *   requested → "Requested" → you asked; tap to withdraw → api.disconnect
 *   incoming  → "Approve"   → they asked; tap to accept  → api.connect
 *   connected → "Connected" → tap to disconnect          → api.disconnect
 *
 * Both Connect and Approve call `api.connect`: for an incoming request the
 * backend accepts the existing row rather than making a competing one (see
 * connections.md).
 *
 * **Only the `connected` → disconnect path routes through the warning modal.**
 * Disconnecting an accepted connection can drop you out of group chats you only
 * share through that person; withdrawing a still-pending request never had a
 * live connection to break, so it mutates straight away — same rule as the web.
 *
 * On success it invalidates every view the change touches (the people lists, the
 * feed, this person's profile + posts, and the requests inbox) so nothing shows
 * a stale button or a post that just (dis)appeared.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { api } from '@/api';
import { DisconnectWarningModal } from '@/components/DisconnectWarningModal';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { ProfileUser } from '@/types';

type ConnectionStatus = ProfileUser['connection_status'];

const LABELS: Record<ConnectionStatus, string> = {
  none: 'Connect',
  requested: 'Requested',
  incoming: 'Approve',
  connected: 'Connected',
};

type Props = {
  userId: number;
  displayName: string;
  connectionStatus: ConnectionStatus;
  /** `md` on a profile header, `sm` in a dense list row. */
  size?: 'sm' | 'md';
};

export function ConnectButton({
  userId,
  displayName,
  connectionStatus,
  size = 'sm',
}: Props) {
  const queryClient = useQueryClient();
  const [showWarning, setShowWarning] = useState(false);

  // "none" and "incoming" are the two states where a tap *connects*; the other
  // two ("requested", "connected") undo an existing link.
  const isConnectAction =
    connectionStatus === 'none' || connectionStatus === 'incoming';

  const mutation = useMutation({
    mutationFn: () =>
      isConnectAction ? api.connect(userId) : api.disconnect(userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: ['connections'] });
      queryClient.invalidateQueries({ queryKey: ['feed'] });
      queryClient.invalidateQueries({ queryKey: ['user', userId] });
      queryClient.invalidateQueries({ queryKey: ['userPosts', userId] });
      queryClient.invalidateQueries({ queryKey: ['connectionRequests'] });
    },
  });

  function handlePress() {
    // Disconnecting a live connection can sever shared group chats, so it goes
    // through the warning first; every other transition mutates immediately.
    if (connectionStatus === 'connected') {
      setShowWarning(true);
      return;
    }
    mutation.mutate();
  }

  // The two "act to connect" states get the filled accent; the two "already in
  // motion" states get the quieter outline — mirrors the web's btn-primary vs
  // btn-ghost split.
  const filled = isConnectAction;

  return (
    <>
      <Pressable
        onPress={handlePress}
        disabled={mutation.isPending}
        accessibilityRole="button"
        accessibilityLabel={`${LABELS[connectionStatus]} ${displayName}`}
        style={({ pressed }) => [
          styles.base,
          size === 'md' ? styles.md : styles.sm,
          filled ? styles.filled : styles.ghost,
          (pressed || mutation.isPending) && styles.pressed,
        ]}
      >
        <Text style={[styles.label, filled ? styles.filledLabel : styles.ghostLabel]}>
          {LABELS[connectionStatus]}
        </Text>
      </Pressable>

      {showWarning && (
        <DisconnectWarningModal
          userId={userId}
          userName={displayName}
          onConfirm={() => {
            setShowWarning(false);
            mutation.mutate();
          }}
          onCancel={() => setShowWarning(false)}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sm: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs + 2 },
  md: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  filled: { backgroundColor: colors.accent },
  ghost: { borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.raised },
  pressed: { opacity: 0.7 },
  label: { fontSize: fontSize.sm, fontWeight: '600' },
  filledLabel: { color: '#ffffff' },
  ghostLabel: { color: colors.ink },
});
