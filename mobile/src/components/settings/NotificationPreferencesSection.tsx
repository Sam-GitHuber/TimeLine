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
import { ActivityIndicator, StyleSheet, Switch, Text, View } from 'react-native';

import { api } from '@/api';
import { colors, fontSize, spacing } from '@/theme';
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
};

const PREFS_KEY = ['notificationPreferences'] as const;

export function NotificationPreferencesSection() {
  const queryClient = useQueryClient();

  const { data: prefs, isLoading } = useQuery({
    queryKey: PREFS_KEY,
    queryFn: api.getNotificationPreferences,
  });

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

  const entries = prefs ? Object.entries(prefs) : [];

  return (
    <View style={styles.section}>
      <Text style={styles.heading}>Notifications</Text>
      <Text style={styles.blurb}>
        Choose what shows up in your activity centre and buzzes your phone.
        Connection requests and group invitations always notify you.
      </Text>

      {isLoading ? (
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
});
