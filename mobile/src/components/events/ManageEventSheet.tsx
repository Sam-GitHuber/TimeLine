/**
 * The event's **Manage** sheet (issue #419) — everything about *running* the
 * event, gathered behind one button instead of scattered down the screen:
 *
 * - **Co-organisers.** The organiser sees who's helping, removes them, and adds
 *   more from a picker of exactly the people the server will accept
 *   (`coOrganiserCandidates` — connected group members). A co-organiser sees
 *   that they're helping and can **step down**.
 * - **Cancel** — the organiser, a co-organiser or a group admin (`can_cancel`).
 * - **Delete** — the organiser or a group admin only (`can_moderate`): it takes
 *   everyone's album photos with it, which is why a co-organiser doesn't get it.
 *
 * Cancel and delete aren't run from in here: they close the sheet and hand back
 * to the event screen, which owns their confirm, their mutation and their
 * refusal alert (#237) — one copy of each, not two.
 *
 * Co-organiser writes report a refusal with an `Alert`, like the screen's other
 * event writes, and refresh through `onChanged` (the screen's `invalidate`, so
 * every surface showing the event moves together).
 */

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { api, serverMessage, WENT_WRONG } from '@/api';
import { useAuth } from '@/auth';
import { Avatar } from '@/components/Avatar';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { Author, Event } from '@/types';

export function ManageEventSheet({
  event,
  onClose,
  onChanged,
  onCancelEvent,
  onDeleteEvent,
}: {
  event: Event;
  onClose: () => void;
  /** Refresh every surface showing this event (the screen's `invalidate`). */
  onChanged: () => void;
  onCancelEvent: () => void;
  onDeleteEvent: () => void;
}) {
  // `is_organiser` is absent on a server from before co-organisers, where
  // `can_manage` still means "the organiser". Reading absence as "not the
  // organiser" would offer the organiser *Step down as co-organiser* — so only
  // an explicit `false` makes someone a co-organiser, and on an old server the
  // co-organiser section simply doesn't appear.
  const isOrganiser = event.is_organiser === true;
  const isCoOrganiser = event.is_organiser === false && event.can_manage;
  const canCancel = (event.can_cancel ?? event.can_moderate) && event.status !== 'cancelled';
  const coOrganisers = event.co_organisers ?? [];
  const [picking, setPicking] = useState(false);

  const candidates = useQuery({
    queryKey: ['coOrganiserCandidates', event.id],
    queryFn: () => api.coOrganiserCandidates(event.id),
    enabled: isOrganiser && picking,
  });

  const add = useMutation({
    mutationFn: (user: Author) => api.addCoOrganiser(event.id, user.id),
    onSuccess: () => {
      // The picker closes; reopening it refetches (the query re-enables), so
      // there's nothing to gain from refetching a list nobody can see.
      setPicking(false);
      onChanged();
    },
    onError: (err) => Alert.alert('Couldn’t add them', serverMessage(err, WENT_WRONG)),
  });
  const remove = useMutation({
    mutationFn: (userId: number) => api.removeCoOrganiser(event.id, userId),
    onSuccess: () => {
      onChanged();
      // Stepping down ends your say over the event, so the sheet has nothing
      // left to offer you.
      if (!isOrganiser) onClose();
      else if (picking) candidates.refetch();
    },
    onError: (err) => Alert.alert('Couldn’t remove them', serverMessage(err, WENT_WRONG)),
  });
  const busy = add.isPending || remove.isPending;

  function confirmStepDown(me: number) {
    Alert.alert(
      'Step down as co-organiser?',
      `${event.organiser.display_name} will still be organising it.`,
      [
        { text: 'Stay on', style: 'cancel' },
        { text: 'Step down', style: 'destructive', onPress: () => remove.mutate(me) },
      ]
    );
  }

  return (
    <Modal
      transparent
      animationType="slide"
      visible
      onRequestClose={() => {
        if (!busy) onClose();
      }}
      accessibilityViewIsModal
    >
      <Pressable
        testID="manage-backdrop"
        style={styles.backdrop}
        onPress={busy ? undefined : onClose}
      >
        <Pressable style={styles.sheet} onPress={() => {}}>
          <ScrollView contentContainerStyle={styles.content}>
            <Text style={styles.title}>Manage event</Text>

            {isOrganiser || isCoOrganiser ? (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Co-organisers</Text>
                <Text style={styles.help}>
                  Co-organisers can set the date, time and place, run polls and
                  cancel. If you leave the group, the event passes to the first
                  one rather than being cancelled.
                </Text>

                {coOrganisers.length === 0 && !isCoOrganiser ? (
                  <Text style={styles.empty}>No co-organisers yet.</Text>
                ) : null}

                {coOrganisers.map((person) => (
                  <View key={person.id} style={styles.personRow}>
                    <Avatar user={person} size="xs" />
                    <Text style={styles.personName}>{person.display_name}</Text>
                    {isOrganiser ? (
                      <Pressable
                        onPress={() => remove.mutate(person.id)}
                        disabled={busy}
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${person.display_name}`}
                        hitSlop={6}
                      >
                        <Text style={styles.removeLabel}>Remove</Text>
                      </Pressable>
                    ) : null}
                  </View>
                ))}

                {isOrganiser && !picking ? (
                  <Pressable
                    onPress={() => setPicking(true)}
                    disabled={busy}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.btn, pressed && styles.pressed]}
                  >
                    <Text style={styles.btnLabel}>+ Add co-organiser</Text>
                  </Pressable>
                ) : null}

                {isOrganiser && picking ? (
                  <View style={styles.picker}>
                    <Text style={styles.pickerTitle}>Choose someone</Text>
                    {candidates.isLoading ? (
                      <ActivityIndicator color={colors.accent} />
                    ) : candidates.isError ? (
                      <Text style={styles.empty}>
                        {serverMessage(candidates.error, WENT_WRONG)}
                      </Text>
                    ) : (candidates.data ?? []).length === 0 ? (
                      <Text style={styles.empty}>
                        Nobody else to add — a co-organiser has to be someone in
                        this group you’re connected with.
                      </Text>
                    ) : (
                      (candidates.data ?? []).map((person) => (
                        <Pressable
                          key={person.id}
                          onPress={() => add.mutate(person)}
                          disabled={busy}
                          accessibilityRole="button"
                          accessibilityLabel={`Add ${person.display_name}`}
                          style={({ pressed }) => [styles.personRow, pressed && styles.pressed]}
                        >
                          <Avatar user={person} size="xs" />
                          <Text style={styles.personName}>{person.display_name}</Text>
                          <Text style={styles.addLabel}>Add</Text>
                        </Pressable>
                      ))
                    )}
                    <Pressable
                      onPress={() => setPicking(false)}
                      disabled={busy}
                      accessibilityRole="button"
                      hitSlop={6}
                    >
                      <Text style={styles.dismissLabel}>Done</Text>
                    </Pressable>
                  </View>
                ) : null}

                {isCoOrganiser ? (
                  <MeStepDown onStepDown={confirmStepDown} disabled={busy} />
                ) : null}
              </View>
            ) : null}

            {canCancel || event.can_moderate ? (
              <View style={styles.section}>
                {canCancel ? (
                  <Pressable
                    onPress={() => {
                      onClose();
                      onCancelEvent();
                    }}
                    disabled={busy}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.dangerBtn, pressed && styles.pressed]}
                  >
                    <Text style={styles.dangerLabel}>Cancel event</Text>
                    <Text style={styles.dangerHelp}>
                      People who said they’re going are told. It stays visible, marked cancelled.
                    </Text>
                  </Pressable>
                ) : null}
                {event.can_moderate ? (
                  <Pressable
                    onPress={() => {
                      onClose();
                      onDeleteEvent();
                    }}
                    disabled={busy}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.dangerBtn, pressed && styles.pressed]}
                  >
                    <Text style={styles.dangerLabel}>Delete event</Text>
                    <Text style={styles.dangerHelp}>
                      Removes it for everyone, with its photos and comments.
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}

            <Pressable
              onPress={onClose}
              disabled={busy}
              accessibilityRole="button"
              style={({ pressed }) => [styles.closeBtn, pressed && styles.pressed]}
            >
              <Text style={styles.btnLabel}>Close</Text>
            </Pressable>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** The co-organiser's own way out — removes *their* row, by the signed-in id. */
function MeStepDown({
  onStepDown,
  disabled,
}: {
  onStepDown: (me: number) => void;
  disabled: boolean;
}) {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <Pressable
      onPress={() => onStepDown(user.pk)}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => [styles.btn, pressed && styles.pressed]}
    >
      <Text style={styles.btnLabel}>Step down as co-organiser</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(28,26,22,0.4)',
    justifyContent: 'flex-end',
  },
  sheet: {
    maxHeight: '85%',
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.raised,
  },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  title: { fontSize: fontSize.lg, fontWeight: '700', color: colors.ink },
  section: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingTop: spacing.md,
    gap: spacing.sm,
  },
  sectionTitle: { fontSize: fontSize.base, fontWeight: '700', color: colors.ink },
  help: { fontSize: fontSize.sm, color: colors.inkSoft, lineHeight: 20 },
  empty: { fontSize: fontSize.sm, color: colors.inkFaint, lineHeight: 20 },
  personRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  personName: { flex: 1, fontSize: fontSize.sm, color: colors.ink },
  removeLabel: { fontSize: fontSize.sm, fontWeight: '600', color: colors.danger },
  addLabel: { fontSize: fontSize.sm, fontWeight: '700', color: colors.accentDeep },
  picker: {
    gap: spacing.xs,
    padding: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  pickerTitle: { fontSize: fontSize.sm, fontWeight: '700', color: colors.ink },
  dismissLabel: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.inkFaint,
    marginTop: spacing.xs,
  },
  btn: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  btnLabel: { fontSize: fontSize.sm, fontWeight: '600', color: colors.ink },
  dangerBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    gap: 2,
  },
  dangerLabel: { fontSize: fontSize.sm, fontWeight: '600', color: colors.danger },
  dangerHelp: { fontSize: 12, color: colors.inkFaint },
  closeBtn: {
    alignSelf: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  pressed: { opacity: 0.7 },
});
