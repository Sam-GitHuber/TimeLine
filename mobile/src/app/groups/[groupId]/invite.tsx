/**
 * Invite people to a group (Phase 9 E3a).
 *
 * The pool is **your connections** (groups.md's add-gate: any member may invite,
 * but only their own connections — no strangers pulled into a shared space),
 * minus anyone already in the group. Multi-select and Invite; each invitee gets a
 * pending invite they accept from their own inbox (consent-first). Mirrors the
 * new-chat picker's shape.
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { api } from '@/api';
import { Avatar } from '@/components/Avatar';
import { dedupeById } from '@/lists';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { PersonSummary } from '@/types';

const FOOTER_PAD = spacing.sm + 2;

export default function GroupInviteScreen() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const id = Number(groupId);
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const [term, setTerm] = useState('');
  const [selected, setSelected] = useState<Set<number>>(() => new Set());

  const connectionsQuery = useInfiniteQuery({
    queryKey: ['connections'],
    queryFn: ({ pageParam }) =>
      pageParam ? api.getPage<PersonSummary>(pageParam) : api.listConnections(),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
  });
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = connectionsQuery;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Existing members are excluded from the pool — you can't invite someone
  // already in the group (the server would reject it too).
  const membersQuery = useQuery({
    queryKey: ['groupMembers', id],
    queryFn: () => api.getGroupMembers(id),
  });
  const memberIds = new Set((membersQuery.data ?? []).map((m) => m.user.id));

  const connections = dedupeById(
    connectionsQuery.data?.pages.flatMap((p) => p.results) ?? []
  ).filter((person) => !memberIds.has(person.id));
  const needle = term.trim().toLowerCase();
  const filtered = needle
    ? connections.filter((p) => p.display_name.toLowerCase().includes(needle))
    : connections;

  function toggle(uid: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }

  const invite = useMutation({
    mutationFn: () => Promise.all([...selected].map((uid) => api.inviteToGroup(id, uid))),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['groupMembers', id] });
      router.back();
    },
    onError: (error) =>
      Alert.alert(
        'Couldn’t invite everyone',
        error instanceof Error ? error.message : 'Something went wrong.'
      ),
  });

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" hitSlop={8}>
          <Text style={styles.back}>← Back</Text>
        </Pressable>
        <Text style={styles.title}>Invite people</Text>
        <View style={styles.backSpacer} />
      </View>

      <View style={styles.searchWrap}>
        <TextInput
          value={term}
          onChangeText={setTerm}
          placeholder="Search your connections…"
          placeholderTextColor={colors.inkFaint}
          autoCorrect={false}
          style={styles.search}
          accessibilityLabel="Search your connections"
        />
      </View>

      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <FlatList
          data={filtered}
          keyExtractor={(p) => String(p.id)}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => {
            const checked = selected.has(item.id);
            return (
              <Pressable
                onPress={() => toggle(item.id)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked }}
                accessibilityLabel={item.display_name}
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              >
                <View style={[styles.check, checked && styles.checkOn]}>
                  {checked && <Text style={styles.checkMark}>✓</Text>}
                </View>
                <Avatar user={item} size="md" />
                <Text style={styles.name} numberOfLines={1}>
                  {item.display_name}
                </Text>
              </Pressable>
            );
          }}
          ListEmptyComponent={
            connectionsQuery.isLoading || membersQuery.isLoading ? (
              <Text style={styles.message}>Loading…</Text>
            ) : connections.length === 0 ? (
              <Text style={styles.message}>
                Everyone you’re connected with is already in this group.
              </Text>
            ) : (
              <Text style={styles.message}>No connections match “{term}”.</Text>
            )
          }
        />

        <View style={[styles.footer, { paddingBottom: FOOTER_PAD + insets.bottom }]}>
          <Text style={styles.count}>
            {selected.size === 0 ? 'Select who to invite' : `${selected.size} selected`}
          </Text>
          <Pressable
            onPress={() => invite.mutate()}
            disabled={selected.size === 0 || invite.isPending}
            accessibilityRole="button"
            accessibilityLabel="Invite"
            style={({ pressed }) => [
              styles.inviteBtn,
              (selected.size === 0 || invite.isPending) && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.inviteLabel}>{invite.isPending ? 'Inviting…' : 'Invite'}</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  fill: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  back: { fontSize: fontSize.sm, color: colors.inkFaint, fontWeight: '600' },
  backSpacer: { width: 48 },
  title: { flex: 1, textAlign: 'center', fontSize: fontSize.base, fontWeight: '700', color: colors.ink },
  searchWrap: {
    paddingHorizontal: spacing.sm + 2,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  search: {
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.md,
    backgroundColor: colors.raised,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: fontSize.base,
    color: colors.ink,
  },
  list: { flex: 1 },
  listContent: { flexGrow: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  rowPressed: { backgroundColor: colors.accentTint },
  check: {
    width: 22,
    height: 22,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: colors.lineStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  checkMark: { color: '#ffffff', fontSize: 13, fontWeight: '800' },
  name: { flex: 1, fontSize: fontSize.base, fontWeight: '600', color: colors.ink },
  message: { padding: spacing.xl, textAlign: 'center', fontSize: fontSize.sm, color: colors.inkFaint, lineHeight: 20 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm + 2,
  },
  count: { flex: 1, fontSize: fontSize.sm - 1, color: colors.inkFaint },
  inviteBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  disabled: { opacity: 0.4 },
  inviteLabel: { fontSize: fontSize.sm, fontWeight: '600', color: '#ffffff' },
  pressed: { opacity: 0.7 },
});
