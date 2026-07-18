/**
 * The "who am I" screen — Milestone B's end state.
 *
 * This is scaffolding, not a product screen: it proves the whole spine works
 * (token stored → Bearer attached → server recognises us → identity rendered)
 * and gives somewhere to test logout from. **Milestone C replaces this with the
 * real feed** (see docs/phases/phase-9-iphone-app.md).
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BASE_URL } from '@/api';
import { useAuth } from '@/auth';
import { colors, fontSize, radius, spacing } from '@/theme';

export default function HomeScreen() {
  const { user, signOut } = useAuth();

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.content}>
        <Text style={styles.eyebrow}>Signed in as</Text>
        <Text style={styles.name}>{user?.display_name}</Text>
        <Text style={styles.email}>{user?.email}</Text>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Milestone B</Text>
          <Text style={styles.cardBody}>
            The auth spine works: tokens are in the Keychain, the Bearer header is
            attached, and the server recognises this device. The feed lands in
            Milestone C.
          </Text>
          <Text style={styles.server}>{BASE_URL}</Text>
        </View>

        <Pressable
          style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
          onPress={signOut}
          accessibilityRole="button"
        >
          <Text style={styles.buttonText}>Log out</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  content: { flex: 1, padding: spacing.lg, justifyContent: 'center' },
  eyebrow: {
    fontSize: fontSize.sm,
    color: colors.inkFaint,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: spacing.xs,
  },
  name: {
    fontSize: fontSize.xl,
    fontWeight: '700',
    color: colors.ink,
  },
  email: {
    fontSize: fontSize.base,
    color: colors.inkSoft,
    marginTop: spacing.xs,
  },
  card: {
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginTop: spacing.xl,
  },
  cardTitle: {
    fontSize: fontSize.base,
    fontWeight: '600',
    color: colors.ink,
    marginBottom: spacing.xs,
  },
  cardBody: {
    fontSize: fontSize.sm,
    color: colors.inkSoft,
    lineHeight: 20,
  },
  server: {
    fontSize: fontSize.sm,
    color: colors.inkFaint,
    marginTop: spacing.sm,
  },
  button: {
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.xl,
  },
  buttonPressed: { backgroundColor: colors.accentTint },
  buttonText: {
    color: colors.ink,
    fontSize: fontSize.base,
    fontWeight: '600',
  },
});
