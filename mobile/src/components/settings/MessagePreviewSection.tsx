/**
 * "Message previews" — the lock-screen preview switch (Phase 10b, M5).
 *
 * Separate from `NotificationPreferencesSection` above it, and the split is the
 * point: those preferences are **per account** and decide *whether* you are
 * notified. This decides *how much a notification says*, and it is **per
 * device** — because what it governs is a lock screen, and a lock screen
 * belongs to a phone. Someone can reasonably want previews on the handset in
 * their pocket and not on the tablet on the kitchen table. Merging the two
 * would put an account-wide switch next to a device-wide one under the same
 * heading, with nothing on screen saying which was which.
 *
 * **Off by default**, and it stays that way: turning a default on later is one
 * line, and quietly starting to show people's messages on their friends' lock
 * screens is not.
 *
 * **iOS only for now.** The mechanism is an APNs field that wakes a notification
 * service extension; FCM has no equivalent, so on Android the switch would
 * change a server flag that nothing acts on. Offering a control that does
 * nothing is worse than not offering it — see M4, which decides whether Android
 * gets its own path.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';

import { serverMessage } from '@/api';
import { pushPreviewState, registerForPush, setPushPreviews } from '@/push';
import { colors, fontSize, radius, spacing } from '@/theme';
import { useHoldOpen } from '@/writeHold';

const PREVIEW_KEY = ['pushPreviewState'] as const;

export function MessagePreviewSection() {
  const queryClient = useQueryClient();

  const stateQuery = useQuery({
    queryKey: PREVIEW_KEY,
    queryFn: pushPreviewState,
    // Nothing below renders on Android, and the read is two trips into the
    // Keystore. The `return null` has to come *after* the hooks, so the work is
    // declined here rather than by moving the guard up.
    enabled: Platform.OS === 'ios',
  });
  const state = stateQuery.data;

  /**
   * **A failed read is not "previews are off"** (#317's lesson, one section
   * along). Without this, a keychain error falls straight through to the
   * `!registered` branch and tells someone to go and switch on notifications
   * they already have on — with no error, no retry, and no way to reach their
   * own switch. `&& !state` rather than a bare `isError`, so a failed *refresh*
   * keeps the switch you are looking at.
   */
  const loadFailed = stateQuery.isError && !state;

  const mutation = useMutation({
    mutationFn: setPushPreviews,
    onMutate: async (next: boolean) => {
      // Optimistic, like every other switch in Settings: flip now, put it back
      // if the server refuses.
      await queryClient.cancelQueries({ queryKey: PREVIEW_KEY });
      const previous = queryClient.getQueryData<typeof state>(PREVIEW_KEY);
      queryClient.setQueryData(PREVIEW_KEY, (old: typeof state) =>
        old ? { ...old, showPreviews: next } : old
      );
      return { previous };
    },
    onError: (_err, _next, context) => {
      if (context?.previous) queryClient.setQueryData(PREVIEW_KEY, context.previous);
    },
    onSuccess: (saved) => {
      // What the server actually stored, not what was asked for.
      queryClient.setQueryData(PREVIEW_KEY, (old: typeof state) =>
        old ? { ...old, showPreviews: saved } : old
      );
    },
  });

  // Leaving Settings mid-save would take the one line that says it failed
  // (#256), and the rollback would put the switch back in a screen nobody is
  // looking at — so you'd walk away believing your messages were private on the
  // lock screen when they had just started appearing on it.
  useHoldOpen(mutation.isPending);

  if (Platform.OS !== 'ios') return null;

  return (
    <View style={styles.section}>
      <Text style={styles.heading}>Message previews</Text>
      <Text style={styles.blurb}>
        Show what a message says on this phone&apos;s lock screen, instead of just
        who it&apos;s from. Off by default, and separate for every device you use.
      </Text>
      <Text style={styles.blurb}>
        The text never travels inside the notification — your phone fetches it
        from TimeLine directly, once the notification has already arrived. Turning
        this on means anyone who can see your lock screen can read your messages.
      </Text>

      {loadFailed ? (
        <View style={styles.failure}>
          <Text style={styles.error} accessibilityRole="alert">
            {serverMessage(
              stateQuery.error,
              'Couldn’t read this device’s preview setting.'
            )}
          </Text>
          <Retry label="Try again" onPress={() => stateQuery.refetch()} />
        </View>
      ) : stateQuery.isLoading ? (
        <ActivityIndicator color={colors.accent} style={styles.spinner} />
      ) : !state?.registered ? (
        // Not an error, and not a switch. There is no server row to toggle
        // until this device has registered for push, so a switch here would
        // 404 — and "previews are off" would be the wrong thing to say to
        // someone who has simply declined notifications altogether.
        //
        // The button matters as much as the sentence. Registration happens on
        // sign-in and cold start and nowhere else, so following the
        // instruction, coming back to the app and finding the same note is the
        // obvious way to write a dead end: the only other cure is a force-quit,
        // which nothing on screen would have told anyone about.
        <View style={styles.failure}>
          <Text style={styles.note}>
            Turn on notifications for TimeLine in your phone&apos;s Settings, then
            check again.
          </Text>
          <Retry
            label="Check again"
            onPress={async () => {
              await registerForPush();
              await stateQuery.refetch();
            }}
          />
        </View>
      ) : (
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Show message text on the lock screen</Text>
          <Switch
            value={state.showPreviews}
            disabled={mutation.isPending}
            onValueChange={(next) => mutation.mutate(next)}
            trackColor={{ true: colors.accent, false: colors.lineStrong }}
            accessibilityLabel="Show message text on the lock screen"
          />
        </View>
      )}

      {mutation.isError ? (
        <Text style={styles.error} accessibilityRole="alert">
          {serverMessage(mutation.error, 'Couldn’t save that. Please try again.')}
        </Text>
      ) : null}
    </View>
  );
}

/** The same outlined button as every other retry in Settings. */
function Retry({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
    >
      <Text style={styles.retryText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: spacing.xl,
    paddingTop: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  heading: { fontSize: fontSize.lg, fontWeight: '700', color: colors.ink },
  blurb: {
    marginTop: spacing.xs,
    fontSize: fontSize.sm,
    color: colors.inkSoft,
    lineHeight: 20,
  },
  spinner: { marginTop: spacing.lg, alignSelf: 'flex-start' },
  note: {
    marginTop: spacing.md,
    fontSize: fontSize.sm,
    color: colors.inkFaint,
    lineHeight: 20,
  },
  failure: { alignItems: 'flex-start' },
  retry: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  retryText: { color: colors.ink, fontWeight: '600' },
  pressed: { opacity: 0.7 },
  row: {
    marginTop: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  rowLabel: { flex: 1, fontSize: fontSize.base, color: colors.ink },
  error: { marginTop: spacing.sm, fontSize: fontSize.sm, color: colors.danger },
});
