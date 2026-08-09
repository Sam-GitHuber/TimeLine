/**
 * A group's members roster (Phase 9 E3a).
 *
 * Every member sees the roster (name + an Admin badge). An **admin** additionally
 * gets per-member controls via a tap → action sheet: promote to admin / demote to
 * member, and remove from the group. The **last-admin guardrail** is enforced
 * server-side (a 400 if the sole admin tries to demote/remove the last admin);
 * its message is surfaced rather than pre-guarded here, so the rule lives in one
 * place. Any member can open the invite picker.
 *
 * An admin can tap **their own** row, and removing it is `removeGroupMember` with
 * your own id — byte for byte the call the ⋯ menu's *Leave* makes, and the server
 * treats it as leaving (`GroupMemberDetailView.delete` allows `is_self` for any
 * member). So that one branch is a leave, and is treated as one: it says so on
 * the menu and the confirm, refreshes what leaving refreshes (`groupCache.ts` —
 * membership gates the home feed and the personal calendar, #282), and navigates
 * back to the Groups tab rather than leaving you on the roster of a group you're
 * no longer in. Removing *someone else* changes no membership of yours, so it
 * stays on the narrow set. The choice is a **flag in the mutation variables**
 * rather than an opaque function, so the success handler can tell the two apart.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api } from '@/api';
import { useAuth } from '@/auth';
import { useActionMenu } from '@/components/ActionMenu';
import { Avatar } from '@/components/Avatar';
import { LEAVE_GROUP_CONFIRM } from '@/components/useGroupActions';
import { invalidateGroupMembership } from '@/groupCache';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { GroupMember } from '@/types';

/**
 * What the roster's one mutation was asked to do. A discriminated variable
 * rather than a callback, because `onSuccess` has to know whether the write
 * ended *your own* membership — and a `() => Promise<void>` can't say.
 */
type RosterAction =
  | { kind: 'role'; userId: number; role: 'admin' | 'member' }
  | { kind: 'remove'; userId: number };

export default function GroupMembersScreen() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const id = Number(groupId);
  const { user: me } = useAuth();
  const queryClient = useQueryClient();

  const groupQuery = useQuery({ queryKey: ['group', id], queryFn: () => api.getGroup(id) });
  const isAdmin = groupQuery.data?.your_role === 'admin';
  /**
   * **A roster whose rows are inert, saying nothing about why** (#321).
   *
   * Your role comes from a *different* query than the roster does, and only the
   * roster's `isError` was ever read. So a failed group fetch beside a
   * succeeding members fetch drew a complete, healthy-looking list — correct
   * names, correct Admin badges — in which nothing was pressable: an admin taps
   * a row to remove a spammer and gets no menu, no alert, nothing at all. The
   * screen stated by omission "you are not an admin of this group", which is a
   * claim about the server's answer made on the strength of a dropped packet.
   *
   * The rows stay inert, deliberately — every control behind them would 403 if
   * we guessed wrong, and guessing *up* means offering an admin action to a
   * member. What changes is that the screen says so, and offers the retry.
   *
   * `!data`, never a bare `isError`: a failed refresh keeps the role it knows.
   */
  const roleUnknown = groupQuery.isError && !groupQuery.data;

  const membersQuery = useQuery({
    queryKey: ['groupMembers', id],
    queryFn: () => api.getGroupMembers(id),
  });

  const mutation = useMutation({
    mutationFn: (action: RosterAction) =>
      action.kind === 'role'
        ? api.setGroupMemberRole(id, action.userId, action.role)
        : api.removeGroupMember(id, action.userId),
    onSuccess: (_result, action) => {
      if (action.kind === 'remove' && action.userId === me?.pk) {
        // You just left. Membership gates the home feed and the personal
        // calendar, and on the app that lie is permanent — the tabs stay mounted,
        // so nothing marks the feed stale and it keeps offering posts the server
        // will now refuse (#277, #282; see `groupCache.ts`). The group and the
        // roster are deliberately *not* invalidated: both would 404 for a
        // non-member, and this screen is about to unmount anyway.
        invalidateGroupMembership(queryClient);
        router.replace('/groups');
        return;
      }
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

  const { openMenu, menu } = useActionMenu();

  function manage(member: GroupMember) {
    if (!isAdmin) return;
    const name = member.user.display_name;
    const isSelf = member.user.id === me?.pk;
    const roleLabel = member.role === 'admin' ? 'Make member' : 'Make admin';
    const nextRole = member.role === 'admin' ? 'member' : 'admin';

    const promote = () =>
      mutation.mutate({ kind: 'role', userId: member.user.id, role: nextRole });
    // Confirm *before* the mutation, so tapping Cancel is a true no-op rather
    // than resolving into the mutation's success path (which would fire the
    // invalidations below for a removal that never happened). Removing your own
    // row *is* leaving, so it says so — literally the ⋯ menu's wording, shared
    // from `useGroupActions` rather than retyped, since the two must not drift.
    const remove = () =>
      Alert.alert(
        isSelf ? LEAVE_GROUP_CONFIRM.title : 'Remove member?',
        isSelf ? LEAVE_GROUP_CONFIRM.message : `Remove ${name} from this group?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: isSelf ? LEAVE_GROUP_CONFIRM.confirm : 'Remove',
            style: 'destructive',
            onPress: () => mutation.mutate({ kind: 'remove', userId: member.user.id }),
          },
        ]
      );

    openMenu({
      title: name,
      items: [
        { label: roleLabel, onPress: promote },
        {
          label: isSelf ? 'Leave group' : 'Remove from group',
          destructive: true,
          onPress: remove,
        },
      ],
    });
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
        // Above the roster rather than in `ListEmptyComponent`: the case this
        // exists for is precisely the one where the members *did* load, so the
        // empty slot never gets its turn.
        ListHeaderComponent={
          roleUnknown ? (
            <View style={styles.notice}>
              <Text style={styles.inlineError}>
                Couldn’t check whether you manage this group, so the member
                actions aren’t available.
              </Text>
              <Pressable
                onPress={() => groupQuery.refetch()}
                accessibilityRole="button"
                accessibilityLabel="Try checking again"
                hitSlop={8}
                style={({ pressed }) => [styles.inlineRetry, pressed && styles.pressed]}
              >
                <Text style={styles.retryText}>Try again</Text>
              </Pressable>
            </View>
          ) : null
        }
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
      {menu}
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
  notice: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  inlineError: { fontSize: fontSize.sm, color: colors.danger, lineHeight: 20 },
  inlineRetry: { alignSelf: 'flex-start', paddingVertical: spacing.xs },
  pressed: { opacity: 0.7 },
});
