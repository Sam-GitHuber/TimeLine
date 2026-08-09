/**
 * The "Change password" section of Settings (Phase 9 E4b), ported from the web
 * `ChangePasswordSection.jsx`.
 *
 * The current password is required — both because the backend enforces it and so
 * that someone at an unlocked screen (or a hijacked session) can't lock the owner
 * out. It's not destructive, so it's an inline expanding form rather than a
 * confirm modal. On success the session stays valid; we just confirm and clear
 * the fields.
 */

import { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { api, serverMessage } from '@/api';
import { colors, fontSize, radius, spacing } from '@/theme';
import { useAndroidBack } from '@/useAndroidBack';
import { useHoldOpen, useWriteHold, WriteHoldProvider } from '@/writeHold';

export function ChangePasswordSection() {
  const [open, setOpen] = useState(false);

  /**
   * Collapsing this section is held while the POST is out (#256).
   *
   * Abandoning a half-*filled* password change is fine, and is what the back
   * handler below exists for. Abandoning a half-*sent* one is the bug: the form
   * is the only renderer of *"Your old password was entered incorrectly"*, and
   * collapsing it takes the sentence with it. You then believe your password is
   * the new one.
   *
   * A hold of its own rather than Settings' — this section decides when the
   * form goes, and the screen only needs to know that *something* is writing,
   * which the form declares to both.
   */
  const hold = useWriteHold();

  // Android back collapses the form rather than leaving Settings, so a press
  // meant to abandon a half-filled password change doesn't do both (#168).
  useAndroidBack(open, () => {
    if (hold.held) return;
    setOpen(false);
  });

  return (
    <View style={styles.section}>
      <Text style={styles.heading}>Change password</Text>
      <Text style={styles.blurb}>
        Update the password you use to sign in. You’ll need your current one.
      </Text>

      {open ? (
        <WriteHoldProvider hold={hold}>
          <ChangePasswordForm onDone={() => setOpen(false)} />
        </WriteHoldProvider>
      ) : (
        <Pressable
          onPress={() => setOpen(true)}
          accessibilityRole="button"
          style={styles.ghostButton}
        >
          <Text style={styles.ghostLabel}>Change password…</Text>
        </Pressable>
      )}
    </View>
  );
}

function ChangePasswordForm({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);

  // Cheap client-side guard so an obvious mismatch doesn't need a round-trip;
  // the backend re-checks everything regardless.
  const mismatch = confirm.length > 0 && next !== confirm;
  const canSubmit = Boolean(current && next && confirm) && !mismatch && !saving;

  // One declaration, reaching both holds above: the section's (which owns Close
  // and Android back) and — because a hold forwards itself upward — the
  // screen's (which owns "← Back" and the swipe). Every one of those routes
  // unmounts this form.
  //
  // Released the moment the request settles, not when the form goes — the
  // success note below needs a way out too, and `saving` is already false by
  // then.
  useHoldOpen(saving);

  async function handleSubmit() {
    if (!canSubmit) return;
    setError(null);
    setSaving(true);
    try {
      await api.changePassword(current, next, confirm);
      setDone(true);
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      // The server's own words matter here — "Your old password was entered
      // incorrectly" is the whole diagnosis — but only when the server actually
      // spoke. Offline, `err.message` was React Native's `Network request
      // failed`, which reads exactly like a rejection and leaves you unable to
      // tell which password the account now has (#243).
      setError(serverMessage(err, 'Couldn’t change your password.'));
    } finally {
      setSaving(false);
    }
  }

  // Typing anywhere clears the success note — the shown "changed" message must
  // not linger over a fresh, unsaved attempt.
  function edit(setter: (value: string) => void) {
    return (value: string) => {
      setter(value);
      setDone(false);
    };
  }

  return (
    <View style={styles.form}>
      <Field
        label="Current password"
        value={current}
        onChangeText={edit(setCurrent)}
        textContentType="password"
      />
      <Field
        label="New password"
        value={next}
        onChangeText={edit(setNext)}
        textContentType="newPassword"
      />
      <Field
        label="Confirm new password"
        value={confirm}
        onChangeText={edit(setConfirm)}
        textContentType="newPassword"
      />

      {mismatch ? (
        <Text style={styles.error}>The new passwords don’t match.</Text>
      ) : null}
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      {done ? (
        <Text style={styles.success} accessibilityRole="alert">
          Your password has been changed.
        </Text>
      ) : null}

      <View style={styles.actions}>
        <Pressable
          onPress={onDone}
          disabled={saving}
          accessibilityRole="button"
          style={[styles.ghostButton, saving && styles.ghostDisabled]}
        >
          <Text style={styles.ghostLabel}>Close</Text>
        </Pressable>
        <Pressable
          onPress={handleSubmit}
          disabled={!canSubmit}
          accessibilityRole="button"
          style={[styles.saveButton, !canSubmit && styles.saveDisabled]}
        >
          <Text style={styles.saveLabel}>
            {saving ? 'Saving…' : 'Change password'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function Field({
  label,
  value,
  onChangeText,
  textContentType,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  textContentType: 'password' | 'newPassword';
}) {
  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        textContentType={textContentType}
        style={styles.input}
        accessibilityLabel={label}
      />
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
  form: { marginTop: spacing.md, gap: spacing.md },
  label: { fontSize: fontSize.sm, fontWeight: '600', color: colors.inkSoft },
  input: {
    marginTop: spacing.xs,
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
  success: { fontSize: fontSize.sm, color: colors.accentDeep },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: spacing.sm,
  },
  ghostButton: {
    marginTop: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    alignSelf: 'flex-start',
  },
  ghostLabel: { fontSize: fontSize.sm, fontWeight: '600', color: colors.ink },
  // The same dimming `saveDisabled` uses: while the request is out, both
  // buttons in the pair are unavailable. Save being gated and Close beside it
  // wide open was the tell in #259.
  ghostDisabled: { opacity: 0.5 },
  saveButton: {
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
  },
  saveDisabled: { opacity: 0.5 },
  saveLabel: { fontSize: fontSize.sm, fontWeight: '700', color: '#ffffff' },
});
