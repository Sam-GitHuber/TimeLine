/**
 * Login screen.
 *
 * Email + password only — there is no username in this product (see
 * docs/reference/accounts.md). Sign-up is deliberately not here: accounts are
 * admin-approved and the sign-up flow needs the email-verification code step, so
 * it lands with the rest of the account screens in Milestone E4. Until then the
 * beta's testers are invited by the maintainer anyway.
 */

import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { serverMessage } from '@/api';
import { useAuth } from '@/auth';
import { KeyboardAwareScroll } from '@/components/KeyboardAvoider';
import { colors, fontSize, radius, spacing } from '@/theme';

// A render error on this screen stops here instead of blanking the whole app
// (#299). expo-router wraps a route in its `ErrorBoundary` export, and installs
// nothing by default — see `components/ErrorBoundary` for what that means.
export { ErrorBoundary } from '@/components/ErrorBoundary';

export default function LoginScreen() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = email.trim() !== '' && password !== '' && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      // No navigation here — AuthGate redirects when status flips to signedIn,
      // so there's exactly one place that decides where a logged-in user goes.
    } catch (err) {
      // The *server's* message is the useful one: it distinguishes a wrong
      // password from an unverified email from an account still awaiting
      // approval, all of which a real tester will hit. `serverMessage` keeps it
      // to the server's own words — a login attempted with no signal has no such
      // answer, and used to render React Native's `Network request failed` as
      // though the server had said it (#243).
      //
      // Note what that means here: offline you get the sentence below, which
      // doesn't mention the connection. That's `serverMessage`'s contract on
      // both clients — the caller's copy wins over our stand-in — and the app
      // has no offline indicator to pair it with while `onlineManager` is
      // unwired (`_layout.tsx`). Worth revisiting together, not here.
      setError(serverMessage(err, 'Couldn’t sign you in. Please try again.'));
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAwareScroll
        style={styles.flex}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>TimeLine</Text>
        <Text style={styles.subtitle}>
          Your friends and family, in the order they posted.
        </Text>

        {/* The visible <Text> labels aren't announced as the field's name by
            VoiceOver — they're separate elements — so each input carries an
            explicit accessibilityLabel. */}
        <Text style={styles.label}>Email</Text>
        <TextInput
          accessibilityLabel="Email"
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="emailAddress"
          placeholder="you@example.com"
          placeholderTextColor={colors.inkFaint}
          editable={!submitting}
        />

        <Text style={styles.label}>Password</Text>
        <TextInput
          accessibilityLabel="Password"
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          textContentType="password"
          placeholderTextColor={colors.inkFaint}
          editable={!submitting}
          onSubmitEditing={handleSubmit}
          returnKeyType="go"
        />

        {error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}

        <Pressable
          style={({ pressed }) => [
            styles.button,
            pressed && styles.buttonPressed,
            !canSubmit && styles.buttonDisabled,
          ]}
          onPress={handleSubmit}
          disabled={!canSubmit}
          accessibilityRole="button"
        >
          {submitting ? (
            <ActivityIndicator color={colors.raised} />
          ) : (
            <Text style={styles.buttonText}>Log in</Text>
          )}
        </Pressable>

        <View style={styles.footer}>
          <Text style={styles.footerText}>
            TimeLine is invite-only while it&rsquo;s in beta. Ask Sam for an
            account.
          </Text>
        </View>
      </KeyboardAwareScroll>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  flex: { flex: 1 },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: spacing.lg,
  },
  title: {
    fontSize: fontSize.xl,
    fontWeight: '700',
    color: colors.ink,
    marginBottom: spacing.xs,
  },
  subtitle: {
    fontSize: fontSize.base,
    color: colors.inkSoft,
    marginBottom: spacing.xl,
  },
  label: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.inkSoft,
    marginBottom: spacing.xs,
  },
  input: {
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 4,
    fontSize: fontSize.base,
    color: colors.ink,
    marginBottom: spacing.md,
  },
  error: {
    color: colors.danger,
    fontSize: fontSize.sm,
    marginBottom: spacing.md,
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  buttonPressed: { backgroundColor: colors.accentDeep },
  buttonDisabled: { opacity: 0.5 },
  buttonText: {
    color: colors.raised,
    fontSize: fontSize.base,
    fontWeight: '600',
  },
  footer: { marginTop: spacing.xl },
  footerText: {
    fontSize: fontSize.sm,
    color: colors.inkFaint,
    textAlign: 'center',
  },
});
