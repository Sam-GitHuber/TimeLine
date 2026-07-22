/**
 * "Message" on a connected person's profile. Ported from the web's
 * `MessageButton.jsx` — get-or-creates the 1:1 conversation with them
 * (`openConversation` is idempotent), then pushes its thread.
 *
 * Only rendered when you're connected (the profile header gates it on
 * `connection_status === 'connected'`); the backend enforces the same rule, so a
 * stray tap would 403 rather than open a cold DM. It sits on the profile action
 * row beside the ConnectButton (E1).
 *
 * Unlike the web — where the drawer opens *beside* the profile so you keep your
 * place — mobile pushes the thread full-screen over the profile, the standard
 * phone pattern (the E2 structure decision: real screens, not a drawer).
 */

import { useMutation } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';

import { api } from '@/api';
import { colors, fontSize, radius, spacing } from '@/theme';

export function MessageButton({ userId }: { userId: number }) {
  const mutation = useMutation({
    mutationFn: () => api.openConversation(userId),
    onSuccess: (conversation) =>
      router.push(`/messages/${conversation.id}`),
  });

  return (
    <Pressable
      onPress={() => mutation.mutate()}
      disabled={mutation.isPending}
      accessibilityRole="button"
      accessibilityLabel="Message"
      style={({ pressed }) => [
        styles.button,
        (pressed || mutation.isPending) && styles.pressed,
      ]}
    >
      <Text style={styles.label}>
        {mutation.isPending ? 'Opening…' : 'Message'}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Matches the ConnectButton's `md` filled variant, so the two sit as a pair.
  button: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.7 },
  label: { fontSize: fontSize.sm, fontWeight: '600', color: '#ffffff' },
});
