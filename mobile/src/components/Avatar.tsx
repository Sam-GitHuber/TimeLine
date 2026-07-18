/**
 * A user's avatar: their uploaded thumbnail, or a coloured circle with their
 * initial. Ported from `frontend/src/components/Avatar.jsx`.
 *
 * **The colour must match the web app's**, so the same person is the same colour
 * wherever you see them. That means keeping two things identical to the web
 * version: the palette *order* below, and the `charCodeAt` sum used to index it.
 * Change either and everyone's avatar silently changes colour on one client
 * only.
 *
 * Seeded from `display_name` (the label the backend computes) rather than the
 * id, matching the web app.
 */

import { StyleSheet, Text, View } from 'react-native';

import { AuthedImage } from './AuthedImage';
import { colors } from '@/theme';

/** Order matters — it's part of the hash. Mirrors the web's `--color-av-*`. */
const AVATAR_COLORS = [
  colors.avClay,
  colors.avOchre,
  colors.avSage,
  colors.avTeal,
  colors.avPlum,
  colors.avMoss,
];

function colorFor(seed: string): string {
  let sum = 0;
  for (const ch of seed) sum += ch.charCodeAt(0);
  return AVATAR_COLORS[sum % AVATAR_COLORS.length];
}

const SIZES = {
  /** Marks a post on the timeline rail — small enough not to crowd the spine. */
  xs: 24,
  sm: 32,
  md: 40,
  lg: 80,
} as const;

type Props = {
  user: { display_name?: string; avatar_thumb?: string | null } | null | undefined;
  size?: keyof typeof SIZES;
};

export function Avatar({ user, size = 'md' }: Props) {
  const dimension = SIZES[size];
  const name = user?.display_name || '?';
  const shape = {
    width: dimension,
    height: dimension,
    borderRadius: dimension / 2,
  };

  if (user?.avatar_thumb) {
    // AuthedImage, not Image — media is auth-gated in production.
    return (
      <AuthedImage
        uri={user.avatar_thumb}
        style={shape}
        contentFit="cover"
        // Decorative: the author's name next to it is the accessible label.
        accessibilityElementsHidden
        importantForAccessibility="no"
      />
    );
  }

  return (
    <View
      style={[styles.fallback, shape, { backgroundColor: colorFor(name) }]}
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      <Text style={[styles.initial, { fontSize: dimension * 0.42 }]}>
        {name.charAt(0).toUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: { alignItems: 'center', justifyContent: 'center' },
  initial: { color: '#ffffff', fontWeight: '600' },
});
