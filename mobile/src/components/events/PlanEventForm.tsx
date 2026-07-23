/**
 * "Plan an event" — the low-friction first step (Phase 9 E3c-a). Any active
 * member creates an event with just a title (title + a date is enough to be
 * real; time, place and custom questions get Set or Polled afterwards on the
 * event page). On success we go straight to the new event so the organiser can
 * light up its dimension chips. Ported from
 * `frontend/src/components/events/PlanEventForm.jsx`.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { api } from '@/api';
import { colors, fontSize, radius, spacing } from '@/theme';

export function PlanEventForm({ groupId }: { groupId: number }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: () => api.createEvent(groupId, { title: title.trim(), description }),
    onSuccess: (event) => {
      queryClient.invalidateQueries({ queryKey: ['groupEvents', groupId] });
      // Replace, not push, so Back from the event lands on the group, not here.
      router.replace(`/events/${event.id}`);
    },
  });

  const trimmed = title.trim();

  return (
    <View style={styles.form}>
      <Text style={styles.label}>What are you planning?</Text>
      <TextInput
        style={styles.input}
        value={title}
        onChangeText={setTitle}
        placeholder="e.g. Grandma’s 80th"
        placeholderTextColor={colors.inkFaint}
        accessibilityLabel="What are you planning?"
        maxLength={200}
        autoFocus
        editable={!create.isPending}
      />

      <Text style={styles.label}>
        Details <Text style={styles.optional}>(optional)</Text>
      </Text>
      <TextInput
        style={[styles.input, styles.multiline]}
        value={description}
        onChangeText={setDescription}
        placeholder="Anything worth saying up front"
        placeholderTextColor={colors.inkFaint}
        accessibilityLabel="Details"
        maxLength={5000}
        multiline
        editable={!create.isPending}
      />

      {create.isError ? (
        <Text style={styles.error} accessibilityRole="alert">
          {create.error instanceof Error ? create.error.message : 'Couldn’t create the event.'}
        </Text>
      ) : null}

      <Pressable
        onPress={() => create.mutate()}
        disabled={!trimmed || create.isPending}
        accessibilityRole="button"
        style={({ pressed }) => [
          styles.submit,
          (pressed || !trimmed || create.isPending) && styles.submitDisabled,
        ]}
      >
        <Text style={styles.submitLabel}>
          {create.isPending ? 'Planning…' : 'Plan an event'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  form: { padding: spacing.md, gap: spacing.sm },
  label: { fontSize: fontSize.sm, fontWeight: '600', color: colors.ink, marginTop: spacing.sm },
  optional: { fontWeight: '400', color: colors.inkFaint },
  input: {
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.md,
    backgroundColor: colors.raised,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: fontSize.base,
    color: colors.ink,
  },
  multiline: { minHeight: 64, textAlignVertical: 'top' },
  error: { fontSize: fontSize.sm, color: colors.danger },
  submit: {
    marginTop: spacing.md,
    alignSelf: 'flex-start',
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
  },
  submitDisabled: { opacity: 0.5 },
  submitLabel: { fontSize: fontSize.sm, fontWeight: '600', color: '#ffffff' },
});
