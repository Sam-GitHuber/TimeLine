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
 *
 * A rejection alerts (issue #236). Without it, a withdraw that 400s — they
 * accepted, or closed their account, while your screen was open — re-enabled a
 * button still reading "Requested" and repainted nothing, since no invalidation
 * runs on the failure path. The tap read as not having registered, so the
 * natural response was to press it again.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text } from 'react-native';

import { api, serverMessage } from '@/api';
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

// What each state's failure sounds like when the server didn't say anything
// usable itself. Named per state because "it didn't work" is much less helpful
// than knowing *which* of the four things you were doing didn't work.
const FAILURES: Record<ConnectionStatus, string> = {
  none: 'Couldn’t send that request — try again.',
  incoming: 'Couldn’t accept that request — try again.',
  requested: 'Couldn’t withdraw that request — try again.',
  connected: 'Couldn’t disconnect — try again.',
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

  // Awaited rather than fired-and-forgotten so the disconnect path can keep its
  // warning dialog up until the write lands — see DisconnectWarningModal.
  //
  // That leans on a deferral recorded in `app/_layout.tsx`: with `onlineManager`
  // left unwired to NetInfo, an offline write *rejects*. Wire it and React
  // Query's default `networkMode: 'online'` would **pause** the mutation instead
  // — `mutateAsync` never settles, so no catch, no alert, and on the disconnect
  // path the dialog it's holding open (which refuses Cancel, backdrop and back
  // while busy) never lets go. The tripwire is invisible from either file alone.
  async function run() {
    const fallback = FAILURES[connectionStatus] ?? FAILURES.none;
    try {
      await mutation.mutateAsync();
      setShowWarning(false);
    } catch (err) {
      // Only the server's own words are fit to show: an `ApiError` it authored
      // carries DRF's `detail`, written for a person ("You can't connect with
      // this person." when a block bars it). Anything else is a runtime string —
      // offline, React Native rejects with `TypeError: Network request failed` —
      // or our own "Request failed (500)" stand-in. See `serverMessage`.
      Alert.alert('Couldn’t do that', serverMessage(err, fallback));
    }
  }

  function handlePress() {
    // Disconnecting a live connection can sever shared group chats, so it goes
    // through the warning first; every other transition mutates immediately.
    if (connectionStatus === 'connected') {
      setShowWarning(true);
      return;
    }
    run();
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
          busy={mutation.isPending}
          onConfirm={run}
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
