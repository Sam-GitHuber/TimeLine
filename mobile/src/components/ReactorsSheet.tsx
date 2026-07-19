/**
 * "Who reacted" — the visible reactor list, grouped by emoji.
 *
 * **Pruned per viewer, server-side.** The list only ever contains people you're
 * connected with (plus yourself), so a reactor you don't know is never named
 * here — reactions can't surface a stranger second-hand. That also means two
 * people can see different lists on the same post, which is correct rather than
 * a bug (reactions.md).
 */

import { useQuery } from '@tanstack/react-query';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { api } from '@/api';
import { Avatar } from './Avatar';
import { colors, fontSize, radius, spacing } from '@/theme';

export function ReactorsSheet({
  visible,
  onClose,
  postId,
  commentId,
}: {
  visible: boolean;
  onClose: () => void;
  postId?: number;
  commentId?: number;
}) {
  const target = postId != null ? { postId } : { commentId };

  const { data, isLoading, error } = useQuery({
    queryKey: ['reactors', postId ?? null, commentId ?? null],
    queryFn: () => api.getReactors(target),
    // Only fetch once the sheet is actually open — this is a per-target request
    // and the feed can hold dozens of targets at a time.
    enabled: visible,
  });

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        style={styles.scrim}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close"
      >
        <Pressable style={styles.sheet} onPress={() => {}}>
          <Text style={styles.title}>Who reacted</Text>

          {isLoading ? (
            <ActivityIndicator color={colors.accent} style={styles.spinner} />
          ) : error ? (
            <Text style={styles.error}>
              {error instanceof Error ? error.message : 'Couldn’t load that.'}
            </Text>
          ) : (
            <ScrollView style={styles.list}>
              {data?.map((group) => (
                <View key={group.emoji} style={styles.group}>
                  <Text style={styles.groupEmoji}>
                    {group.emoji} {group.count}
                  </Text>
                  {group.users.map((user) => (
                    <View key={user.id} style={styles.person}>
                      <Avatar user={user} size="xs" />
                      <Text style={styles.name} numberOfLines={1}>
                        {user.display_name}
                      </Text>
                    </View>
                  ))}
                </View>
              ))}
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(28, 26, 22, 0.35)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.raised,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
    maxHeight: '70%',
    gap: spacing.md,
  },
  title: { fontSize: fontSize.base, fontWeight: '700', color: colors.ink },
  spinner: { marginVertical: spacing.lg },
  error: { fontSize: fontSize.sm, color: colors.danger },
  list: { flexGrow: 0 },
  group: { marginBottom: spacing.md, gap: spacing.sm },
  groupEmoji: { fontSize: fontSize.base, color: colors.inkSoft },
  person: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  name: { fontSize: fontSize.sm, color: colors.ink, flexShrink: 1 },
});
