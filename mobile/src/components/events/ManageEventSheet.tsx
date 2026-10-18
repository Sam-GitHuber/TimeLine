/**
 * The event's **Manage** sheet (issue #419) — everything about *running* the
 * event, gathered behind one button instead of scattered down the screen:
 *
 * - **Co-organisers.** The organiser sees who's helping, removes them, and adds
 *   more from a picker of exactly the people the server will accept
 *   (`coOrganiserCandidates` — connected group members). A co-organiser sees
 *   that they're helping and can **step down**.
 * - **Remind people who haven't answered** (#417) — the organisers. One row
 *   for the RSVP and one per open poll, each a count (never names — a
 *   co-organiser needn't be connected to everyone it reaches) and a button the
 *   server lets you press once a day per row. Runs from in here, unlike cancel:
 *   it's the sheet's own write, so the sheet holds itself open while it's out.
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
import type { Author, Event, ReminderTarget } from '@/types';
import { formatRelativeTime } from '@/utils';

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

  // Reminders (#417). Fetched each time the sheet opens, so the counts and
  // "reminded 3h ago" are as fresh as the press they inform.
  const canRemind = event.can_manage && event.status !== 'cancelled';
  const reminders = useQuery({
    queryKey: ['eventReminders', event.id],
    queryFn: () => api.eventReminders(event.id),
    enabled: canRemind,
    // Dropped when the sheet closes, so reopening shows the spinner rather
    // than last time's buttons — one of which someone may have used since.
    gcTime: 0,
  });
  // The one mutation serves every row, so its success is pinned to the row
  // that was pressed (`null` = the RSVP row, a number = a poll).
  const [sent, setSent] = useState<{ pollId: number | null; count: number } | null>(null);
  const remind = useMutation({
    mutationFn: (pollId: number | null) => api.sendEventReminder(event.id, pollId),
    onMutate: () => setSent(null),
    onSuccess: (data, pollId) => {
      setSent({ pollId, count: data.sent_count });
      reminders.refetch();
    },
    // Most often the 429 of a reminder someone else just sent — so the panel
    // is out of date too; refetch so the button goes.
    onError: (err) => {
      Alert.alert('Couldn’t send the reminder', serverMessage(err, WENT_WRONG));
      reminders.refetch();
    },
  });
  function confirmRemind(pollId: number | null, pending: number) {
    Alert.alert(`Send a reminder to ${people(pending)}?`, undefined, [
      { text: 'Not now', style: 'cancel' },
      { text: 'Send', onPress: () => remind.mutate(pollId) },
    ]);
  }

  const busy = add.isPending || remove.isPending || remind.isPending;

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

            {canRemind && reminders.data?.available !== false ? (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Remind people who haven’t answered</Text>
                <Text style={styles.help}>
                  Sends them one notification from{' '}
                  {isOrganiser ? 'you' : event.organiser.display_name}. You can
                  remind about each thing once a day.
                </Text>
                {reminders.isLoading ? (
                  <ActivityIndicator color={colors.accent} />
                ) : reminders.isError && !reminders.data ? (
                  <Text style={styles.empty}>
                    {serverMessage(reminders.error, 'Couldn’t load who hasn’t answered.')}
                  </Text>
                ) : reminders.data ? (
                  <>
                    <ReminderRow
                      label="Are you going?"
                      unanswered="replied"
                      row={reminders.data.rsvp}
                      pollId={null}
                      busy={busy}
                      sending={remind.isPending && remind.variables === null}
                      sentCount={sent && sent.pollId === null ? sent.count : null}
                      onRemind={confirmRemind}
                    />
                    {reminders.data.polls.map((poll) => (
                      <ReminderRow
                        key={poll.poll_id}
                        label={poll.question}
                        unanswered="voted"
                        row={poll}
                        closesAt={poll.closes_at}
                        pollId={poll.poll_id}
                        busy={busy}
                        sending={remind.isPending && remind.variables === poll.poll_id}
                        sentCount={sent && sent.pollId === poll.poll_id ? sent.count : null}
                        onRemind={confirmRemind}
                      />
                    ))}
                  </>
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

const people = (n: number) => (n === 1 ? '1 person' : `${n} people`);

/** "3h ago" / "just now" — a reminder is at most a day old while it matters. */
function ago(iso: string) {
  const short = formatRelativeTime(iso);
  return /^\d+[mhd]$/.test(short) ? `${short} ago` : short;
}

/** "Fri 14 Nov, 18:00" — with the date, since a poll can close weeks ahead. */
function formatWhen(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * One thing that can be reminded about — the RSVP or one open poll. States how
 * many haven't answered and when it was last reminded about, and drops the
 * button while the server's daily limit stands (it'd only answer 429).
 */
function ReminderRow({
  label,
  unanswered,
  row,
  closesAt,
  pollId,
  busy,
  sending,
  sentCount,
  onRemind,
}: {
  label: string;
  unanswered: 'replied' | 'voted';
  row: ReminderTarget;
  closesAt?: string | null;
  pollId: number | null;
  busy: boolean;
  sending: boolean;
  sentCount: number | null;
  onRemind: (pollId: number | null, pending: number) => void;
}) {
  const pending = row.pending_count;
  const limited = row.next_allowed_at != null;
  return (
    <View style={styles.reminderRow}>
      <Text style={styles.reminderLabel}>{label}</Text>
      <Text style={styles.help}>
        {pending === 0
          ? `Everyone has ${unanswered}.`
          : `${people(pending)} ${pending === 1 ? 'hasn’t' : 'haven’t'} ${unanswered} yet.`}
      </Text>
      {closesAt ? (
        <Text style={styles.dangerHelp}>Voting closes {formatWhen(closesAt)}</Text>
      ) : null}
      {row.last_sent_at ? (
        <Text style={styles.dangerHelp}>
          Reminded {ago(row.last_sent_at)}
          {limited && row.next_allowed_at
            ? ` · you can remind again ${formatWhen(row.next_allowed_at)}`
            : ''}
        </Text>
      ) : null}
      {pending > 0 && !limited ? (
        <Pressable
          onPress={() => onRemind(pollId, pending)}
          disabled={busy}
          accessibilityRole="button"
          style={({ pressed }) => [styles.btn, pressed && styles.pressed]}
        >
          <Text style={styles.btnLabel}>
            {sending ? 'Sending…' : `Remind ${people(pending)}`}
          </Text>
        </Pressable>
      ) : null}
      {sentCount != null ? (
        <Text accessibilityRole="text" style={styles.help}>
          Reminder sent to {people(sentCount)}.
        </Text>
      ) : null}
    </View>
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
  reminderRow: {
    gap: 2,
    padding: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
  },
  reminderLabel: { fontSize: fontSize.sm, fontWeight: '700', color: colors.ink },
  pressed: { opacity: 0.7 },
});
