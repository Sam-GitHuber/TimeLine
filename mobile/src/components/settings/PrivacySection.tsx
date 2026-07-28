/**
 * The "Privacy" section of Settings (Phase 9b M4) — currently just read
 * receipts, and a natural home for the privacy switches that follow.
 *
 * It's a section of its own rather than a row under Notifications because it
 * isn't one: nothing is ever notified when someone reads a message, which is
 * also why the flag lives on the user rather than in `NotificationPreference`
 * (see `docs/reference/messaging.md`). Filing it under Notifications would
 * suggest turning it off makes something stop buzzing, which it doesn't.
 *
 * The wording says both halves out loud, because the symmetry is the part
 * people don't expect: turning this off doesn't just hide you, it also stops
 * you seeing anyone else. Discovering that after the fact would feel like a
 * trick.
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { StyleSheet, Switch, Text, View } from 'react-native';

import { api } from '@/api';
import { useAuth } from '@/auth';
import { colors, fontSize, spacing } from '@/theme';

export function PrivacySection() {
  const { user, refreshUser } = useAuth();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  // The auth context already holds the current value, so there's nothing to
  // fetch — `send_read_receipts` rides on the same "who am I" payload that
  // renders the rest of the app.
  const enabled = user?.send_read_receipts ?? true;

  async function toggle(next: boolean) {
    setSaving(true);
    setFailed(false);
    try {
      await api.setReadReceipts(next);
      await refreshUser();
      // The setting decides what the *server* puts in a conversation payload,
      // so any thread already loaded is now stale in both directions — its
      // participants either gained read markers or lost them. Dropping the
      // cached conversations is what makes the ticks appear (or vanish)
      // immediately rather than at the next poll of a screen you're not on.
      queryClient.invalidateQueries({ queryKey: ['conversation'] });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={styles.section}>
      <Text style={styles.heading}>Privacy</Text>

      <View style={styles.row}>
        <View style={styles.rowText}>
          <Text style={styles.rowLabel}>Send read receipts</Text>
          <Text style={styles.rowHint}>
            Lets people see when you’ve read their messages. Turning it off also
            stops you seeing when they’ve read yours — in group chats too.
          </Text>
        </View>
        <Switch
          value={enabled}
          disabled={saving}
          onValueChange={toggle}
          trackColor={{ true: colors.accent, false: colors.lineStrong }}
          accessibilityLabel="Send read receipts"
        />
      </View>

      {failed ? (
        <Text style={styles.error} accessibilityRole="alert">
          Couldn’t save that. Please try again.
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
  row: {
    marginTop: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  rowText: { flex: 1, gap: spacing.xs },
  rowLabel: { fontSize: fontSize.base, color: colors.ink },
  rowHint: { fontSize: fontSize.sm, color: colors.inkSoft, lineHeight: 18 },
  error: { marginTop: spacing.sm, fontSize: fontSize.sm, color: colors.danger },
});
