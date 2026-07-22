/**
 * A group's members roster (Phase 9 E3a).
 *
 * Every member sees the roster (name + an Admin badge). An **admin** additionally
 * gets per-member controls via a tap → action sheet: promote to admin / demote to
 * member, and remove from the group. The **last-admin guardrail** is enforced
 * server-side (a 400 if the sole admin tries to demote/remove the last admin);
 * its message is surfaced rather than pre-guarded here, so the rule lives in one
 * place. Any member can open the invite picker.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api } from '@/api';
import { useAuth } from '@/auth';
import { Avatar } from '@/components/Avatar';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { GroupMember } from '@/types';

export default function GroupMembersScreen() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const id = Number(groupId);
  const { user: me } = useAuth();
  const queryClient = useQueryClient();

  const groupQuery = useQuery({ queryKey: ['group', id], queryFn: () => api.getGroup(id) });
  const isAdmin = groupQuery.data?.your_role === 'admin';

  const membersQuery = useQuery({
    queryKey: ['groupMembers', id],
    queryFn: () => api.getGroupMembers(id),
  });

  const mutation = useMutation({
    mutationFn: (fn: () => Promise<void>) => fn(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['groupMembers', id] });
      // Your own role or the member count can change (demoting yourself, removing
      // someone), so refresh the group and the list too.
      queryClient.invalidateQueries({ queryKey: ['group', id] });
      queryClient.invalidateQueries({ queryKey: ['groups'] });
    },
    onError: (error) =>
      Alert.alert(
        'Couldn’t do that',
        error instanceof Error ? error.message : 'Something went wrong.'
      ),
  });

  function manage(member: GroupMember) {
    if (!isAdmin) return;
    const name = member.user.display_name;
    const roleAction =
      member.role === 'admin'
        ? { label: 'Make member', run: () => api.setGroupMemberRole(id, member.user.id, 'member') }
        : { label: 'Make admin', run: () => api.setGroupMemberRole(id, member.user.id, 'admin') };
    const removeAction = {
      label: 'Remove from group',
      run: () =>
        new Promise<void>((resolve, reject) => {
          Alert.alert('Remove member?', `Remove ${name} from this group?`, [
            { text: 'Cancel', style: 'cancel', onPress: () => resolve() },
            {
              text: 'Remove',
              style: 'destructive',
              onPress: () =>
                api.removeGroupMember(id, member.user.id).then(resolve).catch(reject),
            },
          ]);
        }),
    };
    const actions = [roleAction, removeAction];
    const labels = [...actions.map((a) => a.label), 'Cancel'];

    const pick = (i: number) => {
      if (i < actions.length) mutation.mutate(actions[i].run);
    };

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { title: name, options: labels, destructiveButtonIndex: 1, cancelButtonIndex: labels.length - 1 },
        pick
      );
    } else {
      Alert.alert(name, undefined, [
        ...actions.map((a, i) => ({ text: a.label, onPress: () => pick(i) })),
        { text: 'Cancel', style: 'cancel' as const },
      ]);
    }
  }

  const members = membersQuery.data ?? [];

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" hitSlop={8}>
          <Text style={styles.back}>← Back</Text>
        </Pressable>
        <Text style={styles.title}>Members</Text>
        <Pressable
          onPress={() => router.push(`/groups/${id}/invite`)}
          accessibilityRole="button"
          accessibilityLabel="Invite people"
          hitSlop={8}
        >
          <Text style={styles.invite}>Invite</Text>
        </Pressable>
      </View>

      <FlatList
        data={members}
        keyExtractor={(m) => String(m.user.id)}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => {
          const isSelf = item.user.id === me?.pk;
          return (
            <Pressable
              onPress={() => manage(item)}
              disabled={!isAdmin}
              accessibilityRole={isAdmin ? 'button' : 'text'}
              accessibilityLabel={
                isAdmin ? `Manage ${item.user.display_name}` : item.user.display_name
              }
              style={({ pressed }) => [styles.row, isAdmin && pressed && styles.rowPressed]}
            >
              <Avatar user={item.user} size="md" />
              <Text style={styles.name} numberOfLines={1}>
                {item.user.display_name}
                {isSelf ? ' (you)' : ''}
              </Text>
              {item.role === 'admin' && (
                <View style={styles.adminBadge}>
                  <Text style={styles.adminText}>Admin</Text>
                </View>
              )}
            </Pressable>
          );
        }}
        ListEmptyComponent={
          membersQuery.isLoading ? (
            <ActivityIndicator color={colors.accent} style={styles.spinner} />
          ) : membersQuery.isError ? (
            <View style={styles.centre}>
              <Text style={styles.emptyBody}>Couldn’t load members.</Text>
              <Pressable style={styles.retry} onPress={() => membersQuery.refetch()}>
                <Text style={styles.retryText}>Try again</Text>
              </Pressable>
            </View>
          ) : null
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  back: { fontSize: fontSize.sm, color: colors.inkFaint, fontWeight: '600' },
  title: { flex: 1, textAlign: 'center', fontSize: fontSize.base, fontWeight: '700', color: colors.ink },
  invite: { fontSize: fontSize.sm, color: colors.accent, fontWeight: '600' },
  listContent: { flexGrow: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md - 2,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  rowPressed: { backgroundColor: colors.accentTint },
  name: { flex: 1, fontSize: fontSize.base, fontWeight: '600', color: colors.ink },
  adminBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: colors.accentTint,
  },
  adminText: { fontSize: fontSize.sm - 1, fontWeight: '700', color: colors.accentDeep },
  spinner: { marginTop: spacing.xl },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.sm },
  emptyBody: { fontSize: fontSize.sm, color: colors.inkSoft, textAlign: 'center' },
  retry: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  retryText: { color: colors.ink, fontWeight: '600' },
});
