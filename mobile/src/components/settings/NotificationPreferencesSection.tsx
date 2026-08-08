/**
 * The "Notifications" section of Settings (Phase 9 E4b), ported from the web
 * `NotificationPreferencesSection.jsx`.
 *
 * The API returns a `{ kind: bool }` map over just the *mutable* kinds — the
 * connection/invite kinds are always-on and never appear here (you can't miss
 * "someone wants to connect"). Toggling a kind off means no notification of that
 * kind is created at all, and — since Milestone D — no push either.
 *
 * Each toggle is optimistic: flip immediately, roll back on failure, and treat
 * the server's returned merged map as the source of truth. The web uses a custom
 * styled checkbox; a phone uses the OS `Switch`, which is the native affordance.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';

import { api, serverMessage } from '@/api';
import { colors, fontSize, radius, spacing } from '@/theme';
import { useHoldOpen } from '@/writeHold';
import type { NotificationPreferences } from '@/types';

// Friendly labels per kind. A kind the backend adds later still renders (falling
// back to its raw key), so a missing label degrades gracefully rather than
// dropping the toggle. Kept in step with the web LABELS map.
const LABELS: Record<string, string> = {
  post_reply: 'Replies to your posts',
  comment_reply: 'Replies to your comments',
  reaction: 'Reactions to your posts and comments',
  event_created: 'New events in your groups',
  poll_opened: 'Polls opened on events',
  event_scheduled: "When an event's date is set",
  event_updated: "Changes to events you're going to",
  event_cancelled: 'Events being cancelled',
  event_comment: 'Comments on events you organised',
  event_photos: "Photos added to events you're going to",
  // Phase 9b M8. Phrased as exactly what it does: not a blanket mentions
  // on/off, only whether a mention beats a chat you muted. See messaging.md.
  mention: 'Let @mentions notify me in muted chats',
};

const PREFS_KEY = ['notificationPreferences'] as const;

export function NotificationPreferencesSection() {
  const queryClient = useQueryClient();

  const prefsQuery = useQuery({
    queryKey: PREFS_KEY,
    queryFn: api.getNotificationPreferences,
  });
  const { data: prefs, isLoading } = prefsQuery;

  /**
   * **Zero toggles is a claim, and it was the wrong one** (#317).
   *
   * Only `mutation.isError` was ever rendered; the *query*'s error never was. So
   * a failed load left `prefs` undefined, `entries` fell back to `[]`, and the
   * "Notifications" heading and its blurb sat over nothing at all — which reads
   * as "there are no settings" rather than "we couldn't load them". No retry
   * either, so the only recovery was to guess that leaving Settings and coming
   * back might help.
   *
   * `&& !prefs`, never a bare `isError`: a failed refresh keeps the switches
   * you're looking at, and their optimistic rollback keeps working.
   */
  const loadFailed = prefsQuery.isError && !prefs;

  const mutation = useMutation({
    mutationFn: (patch: NotificationPreferences) =>
      api.updateNotificationPreferences(patch),
    onMutate: async (patch) => {
      // Optimistic: flip the toggle immediately, roll back on failure.
      await queryClient.cancelQueries({ queryKey: PREFS_KEY });
      const previous =
        queryClient.getQueryData<NotificationPreferences>(PREFS_KEY);
      queryClient.setQueryData<NotificationPreferences>(PREFS_KEY, (old) => ({
        ...(old ?? {}),
        ...patch,
      }));
      return { previous };
    },
    onError: (_err, _patch, context) => {
      if (context?.previous) {
        queryClient.setQueryData(PREFS_KEY, context.previous);
      }
    },
    onSuccess: (data) => {
      // The server returns the full merged map — treat it as the truth.
      queryClient.setQueryData(PREFS_KEY, data);
    },
  });

  // Leaving Settings mid-save would take the one line that says it failed
  // (#256). The rollback in `onError` puts the switch back, but it puts it back
  // in a screen nobody is looking at — so you'd walk away believing reactions
  // had stopped buzzing your phone.
  useHoldOpen(mutation.isPending);

  const entries = prefs ? Object.entries(prefs) : [];

  return (
    <View style={styles.section}>
      <Text style={styles.heading}>Notifications</Text>
      <Text style={styles.blurb}>
        Choose what shows up in your activity centre and buzzes your phone.
        Connection requests and group invitations always notify you.
      </Text>

      {loadFailed ? (
        <View style={styles.failure}>
          <Text style={styles.error} accessibilityRole="alert">
            {serverMessage(
              prefsQuery.error,
              'Couldn’t load your notification settings.'
            )}
          </Text>
          <Pressable
            onPress={() => prefsQuery.refetch()}
            accessibilityRole="button"
            style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
          >
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : isLoading ? (
        <ActivityIndicator color={colors.accent} style={styles.spinner} />
      ) : (
        <View style={styles.list}>
          {entries.map(([kind, enabled], index) => (
            <View
              key={kind}
              style={[styles.row, index > 0 && styles.rowDivider]}
            >
              <Text style={styles.rowLabel}>{LABELS[kind] ?? kind}</Text>
              <Switch
                value={enabled}
                // Guarding on isPending mirrors the web's disabled state, so a
                // second flip can't race an in-flight save.
                disabled={mutation.isPending}
                onValueChange={(next) => mutation.mutate({ [kind]: next })}
                trackColor={{ true: colors.accent, false: colors.lineStrong }}
                accessibilityLabel={LABELS[kind] ?? kind}
              />
            </View>
          ))}
        </View>
      )}

      {mutation.isError ? (
        <Text style={styles.error} accessibilityRole="alert">
          Couldn’t save that preference. Please try again.
        </Text>
      ) : null}
    </View>
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
  list: { marginTop: spacing.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  rowDivider: { borderTopWidth: 1, borderTopColor: colors.line },
  rowLabel: { flex: 1, fontSize: fontSize.base, color: colors.ink },
  error: { marginTop: spacing.sm, fontSize: fontSize.sm, color: colors.danger },
  failure: { alignItems: 'flex-start' },
  // The same outlined button as every other retry in the app.
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
});
