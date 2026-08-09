/**
 * The "Delete account" danger zone of Settings (Phase 9 E4b), ported from the
 * web `DeleteAccountSection.jsx`. App Review also checks that a social app
 * offers in-app account deletion, so this is a parity *and* a compliance item.
 *
 * Because it's irreversible (UK GDPR erasure — your posts, photos, comments and
 * messages all go), the confirm modal makes you re-enter your password; the
 * backend re-checks it. On success the server session is dead, so we `signOut`
 * — which wipes the device tokens and, via the auth gate, boots the app back to
 * a clean logged-out login screen. The `unregisterPush`/`logout` calls inside
 * `signOut` are best-effort and already swallow the failures a just-deleted
 * account provokes (its token 401s), so no special-casing is needed here.
 */

import { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { api, serverMessage } from '@/api';
import { useAuth } from '@/auth';
import { KeyboardAvoider } from '@/components/KeyboardAvoider';
import { colors, fontSize, radius, spacing } from '@/theme';

export function DeleteAccountSection() {
  const [confirming, setConfirming] = useState(false);

  return (
    <View style={styles.section}>
      <Text style={styles.heading}>Delete account</Text>
      <Text style={styles.blurb}>
        Permanently delete your account and everything you’ve posted — your
        posts, photos, comments and messages. This can’t be undone.
      </Text>
      <Pressable
        onPress={() => setConfirming(true)}
        accessibilityRole="button"
        style={styles.dangerOutline}
      >
        <Text style={styles.dangerOutlineLabel}>Delete my account…</Text>
      </Pressable>

      {confirming ? (
        <ConfirmDeleteModal onCancel={() => setConfirming(false)} />
      ) : null}
    </View>
  );
}

function ConfirmDeleteModal({ onCancel }: { onCancel: () => void }) {
  const { signOut } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // The delete landed and we're on our way out. Keeps the button spent — the
  // dismissal gate has already let go by then, and a second press would fire a
  // delete at a session that no longer exists.
  const [done, setDone] = useState(false);

  async function handleDelete() {
    if (deleting || done || !password) return;
    setError(null);
    setDeleting(true);
    try {
      await api.deleteAccount(password);
      // The write landed, so there's no rejection left for this modal to show
      // and the gate has done its job — let go of it *before* `signOut`, which
      // is the one part of this that can hang (it makes its own
      // `unregisterPush`/`logout` round trips). Holding it across those would
      // seal someone into a "Deleting…" box with no way out, which is the trap
      // this issue exists to avoid rather than move somewhere else.
      setDeleting(false);
      setDone(true);
      // The account (and session) is gone. signOut wipes the device tokens and
      // the auth gate routes to /login for a clean logged-out boot.
      await signOut();
    } catch (err) {
      // `serverMessage`, not `err.message`: this is the one irreversible action
      // in the app, and the sentence here is what someone reads to decide
      // whether the account still exists. A request that never left the phone
      // used to surface React Native's `Network request failed`, which is
      // indistinguishable from the server having refused the password — so the
      // fallback written for exactly this case has to be the one that shows
      // (#243).
      setError(serverMessage(err, 'Couldn’t delete your account.'));
      setDeleting(false);
    }
  }

  return (
    <Modal
      transparent
      animationType="fade"
      visible
      onRequestClose={() => {
        if (!deleting) onCancel();
      }}
      accessibilityViewIsModal
    >
      {/* Required since #172 mounted `KeyboardProvider`: that strips the
          `adjustResize` React Native gives every modal dialog, so this password
          field — which `autoFocus`es, opening the keyboard immediately — would
          otherwise sit behind it along with the Delete button. See
          `components/KeyboardAvoider.tsx`. The avoider pads the bottom and the
          backdrop then centres the card in what's left. */}
      <KeyboardAvoider style={styles.avoider}>
        {/* Every way out — backdrop, Cancel, and the Android hardware back
            above — is held shut while the delete is in flight (issue #254).
            The rejection ("wrong password", most often) renders inside this
            modal, so dismissing it mid-request tears down the only thing that
            could say why nothing happened, and leaves you unsure whether your
            account still exists. Matches the web's `ConfirmDeleteDialog`. */}
        <Pressable
          testID="delete-account-backdrop"
          style={styles.backdrop}
          onPress={deleting ? undefined : onCancel}
        >
          <Pressable style={styles.card} onPress={() => {}}>
            <Text style={styles.cardTitle}>Delete your account?</Text>
            <Text style={styles.cardBody}>
              This permanently deletes your account and all your content. It can’t
              be undone. Enter your password to confirm.
            </Text>

            <Text style={styles.label}>Password</Text>
            <TextInput
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              textContentType="password"
              style={styles.input}
              accessibilityLabel="Password"
            />

            {error ? (
              <Text style={styles.error} accessibilityRole="alert">
                {error}
              </Text>
            ) : null}

            <View style={styles.actions}>
              <Pressable
                onPress={onCancel}
                disabled={deleting}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.btn,
                  styles.ghost,
                  (pressed || deleting) && styles.pressed,
                ]}
              >
                <Text style={styles.ghostLabel}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={handleDelete}
                disabled={deleting || done || !password}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.btn,
                  styles.danger,
                  (pressed || deleting || done || !password) && styles.pressed,
                ]}
              >
                {deleting || done ? (
                  <ActivityIndicator color="#ffffff" size="small" />
                ) : (
                  <Text style={styles.dangerLabel}>Delete forever</Text>
                )}
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoider>
    </Modal>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: spacing.xl,
    paddingTop: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  heading: { fontSize: fontSize.lg, fontWeight: '700', color: colors.danger },
  blurb: {
    marginTop: spacing.xs,
    fontSize: fontSize.sm,
    color: colors.inkSoft,
    lineHeight: 20,
  },
  dangerOutline: {
    marginTop: spacing.md,
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  dangerOutlineLabel: { fontSize: fontSize.sm, fontWeight: '600', color: colors.danger },

  avoider: { flex: 1 },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(28,26,22,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.raised,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  cardTitle: { fontSize: fontSize.lg, fontWeight: '700', color: colors.ink },
  cardBody: { fontSize: fontSize.sm, color: colors.inkSoft, lineHeight: 20 },
  label: {
    marginTop: spacing.sm,
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.inkSoft,
  },
  input: {
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    fontSize: fontSize.base,
    color: colors.ink,
  },
  error: { fontSize: fontSize.sm, color: colors.danger },
  actions: {
    marginTop: spacing.md,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
  },
  btn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    minWidth: 96,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ghost: { borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.raised },
  ghostLabel: { fontSize: fontSize.sm, fontWeight: '600', color: colors.ink },
  danger: { backgroundColor: colors.danger },
  dangerLabel: { fontSize: fontSize.sm, fontWeight: '600', color: '#ffffff' },
  pressed: { opacity: 0.7 },
});
