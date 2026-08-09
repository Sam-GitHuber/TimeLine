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
import { useState } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { api, serverMessage, WENT_WRONG } from '@/api';
import { Avatar } from '@/components/Avatar';
import { KeyboardAvoider } from '@/components/KeyboardAvoider';
import { dedupeById, useFetchAllPages } from '@/lists';
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

  // Every page of your connections, since the person you want to invite can
  // sort past the first twenty. A page that fails stops the walk rather than
  // retrying it forever (#248) — so the list can end short, and the banner
  // below is what keeps that from reading as "you aren't connected to them",
  // which is a wrong answer rather than a missing one.
  const connectionsQuery = useInfiniteQuery({
    queryKey: ['connections'],
    queryFn: ({ pageParam }) =>
      pageParam ? api.getPage<PersonSummary>(pageParam) : api.listConnections(),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
  });
  useFetchAllPages(connectionsQuery);

  // Existing members are excluded from the pool — you can't invite someone
  // already in the group (the server would reject it too).
  const membersQuery = useQuery({
    queryKey: ['groupMembers', id],
    queryFn: () => api.getGroupMembers(id),
  });
  /**
   * **The roster is what filters this picker, so not having it is a wrong list,
   * not a short one** (#317).
   *
   * `(membersQuery.data ?? [])` turns "we couldn't ask who's in this group" into
   * "this group has nobody in it", and the `.filter` below then offers people
   * who are **already members**. Tick three, tap Invite, and the `allSettled`
   * tally comes back "Invited 0 of 3" — a failed read rendered as fact and then
   * acted on. So the roster is named here, once, and both the list and the write
   * read the same value rather than each deciding for itself.
   *
   * `connectionsQuery` one query up already had its half of this (#248); this is
   * the same answer the web's `GroupPage` gave its "Start a chat" in #314.
   */
  const roster = membersQuery.data;
  const rosterMissing = !roster;
  const memberIds = new Set((roster ?? []).map((m) => m.user.id));

  const connections = dedupeById(
    connectionsQuery.data?.pages.flatMap((p) => p.results) ?? []
  ).filter((person) => !memberIds.has(person.id));
  const needle = term.trim().toLowerCase();
  const filtered = needle
    ? connections.filter((p) => p.display_name.toLowerCase().includes(needle))
    : connections;

  /**
   * Who is actually going to be invited: the ticks, **intersected with the pool
   * they were ticked from**.
   *
   * `selected` is raw user input and outlives the list it was made against, so
   * it can't be the answer on its own. The case that matters is the roster
   * arriving *late*: the picker offers Ada while the roster is missing, Ada gets
   * ticked, the roster lands and takes her out of the list — and a `selected`
   * read directly would still carry her, so Invite would fire at a member and
   * come back "Invited 2 of 3". That is the bug this screen was fixed for,
   * delayed by one tap rather than prevented.
   *
   * Derived rather than pruned in an effect: the pool is already a value on
   * every render, and an effect racing the roster's arrival is the same class of
   * mistake one layer down. Against `connections`, not `filtered` — typing in
   * the search box must not untick anyone.
   */
  const pool = new Set(connections.map((person) => person.id));
  const chosen = [...selected].filter((uid) => pool.has(uid));

  function toggle(uid: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }

  const invite = useMutation({
    // `allSettled`, not `all`: the invites are independent, so one that the
    // server rejects (a since-blocked connection, or someone already invited —
    // pending invitees aren't filtered from the pool) must not discard the ones
    // that succeeded. We tally the outcomes and report them, rather than failing
    // the whole batch on the first rejection.
    mutationFn: async () => {
      const ids = chosen;
      const results = await Promise.allSettled(
        ids.map((uid) => api.inviteToGroup(id, uid))
      );
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected'
      );
      // Only the *server's* own words are worth quoting to explain a rejection.
      // A batch that failed because the phone had no signal rejects carrying our
      // stand-in sentence, and quoting that here would shadow the authored line
      // below — which is the one written for exactly this case (#243). `null`
      // fallback, so that line stays reachable.
      const firstError = serverMessage(rejected[0]?.reason, null);
      return { total: ids.length, failed: rejected.length, firstError };
    },
    onSuccess: ({ total, failed, firstError }) => {
      queryClient.invalidateQueries({ queryKey: ['groupMembers', id] });
      if (failed === 0) {
        router.back();
      } else if (failed === total) {
        // Nothing went through — keep the picker open so they can retry.
        Alert.alert(
          'Couldn’t invite anyone',
          firstError ?? 'None of the invites went through. Please try again.'
        );
      } else {
        // Some landed; those people now have pending invites, so leave.
        Alert.alert(
          'Some invites didn’t send',
          `Invited ${total - failed} of ${total}. ${failed} couldn’t be invited.`
        );
        router.back();
      }
    },
    onError: (error) =>
      Alert.alert(
        'Couldn’t invite everyone',
        serverMessage(error, WENT_WRONG)
      ),
  });

  /**
   * The write refuses on a roster it doesn't have, rather than proceeding.
   *
   * Not `disabled` on the button: a control that goes dead with no explanation
   * is its own dead end, and this is the case where the picker looks entirely
   * normal — the names are real connections, they're just not filtered. Saying
   * why and asking again is what the web's "Start a chat" does (#314).
   *
   * `rosterMissing` rather than the query's error flag, so the still-loading
   * case is refused too: the list is equally unfiltered while the request is
   * out, and there is nothing on screen to say so.
   */
  function sendInvites() {
    if (rosterMissing) {
      Alert.alert(
        'Couldn’t check who’s already in this group',
        'Some of the people listed may already be members, so those invites ' +
          'would bounce. Trying again — give it a moment.'
      );
      void membersQuery.refetch();
      return;
    }
    invite.mutate();
  }

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

      <KeyboardAvoider style={styles.fill}>
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
          ListHeaderComponent={
            // Above the rows, not in the empty state, because the case both of
            // these exist for is the list that *isn't* empty: names are on
            // screen, and what's wrong with them can't be seen by looking.
            <>
              {/* Page one landed and page two didn't, so the names on screen
                  look like all the names there are (#248). */}
              {connectionsQuery.isError ? (
                <Text style={styles.banner}>
                  Couldn’t load your connections.
                </Text>
              ) : null}
              {/* And the mirror: the roster is what takes existing members
                  *out* of the list, so without it the list has too many rather
                  than too few (#317). Said before the tick, not after the
                  "Invited 0 of 3". */}
              {membersQuery.isError && rosterMissing ? (
                <Text style={styles.banner}>
                  Couldn’t check who’s already in this group, so some of these
                  people may be members already.
                </Text>
              ) : null}
            </>
          }
          ListEmptyComponent={
            connectionsQuery.isLoading || membersQuery.isLoading ? (
              <Text style={styles.message}>Loading…</Text>
            ) : connections.length > 0 ? (
              // The pool isn't empty, so this is a search miss and nothing else
              // — true whatever the roster did, and said whatever it did.
              <Text style={styles.message}>No connections match “{term}”.</Text>
            ) : connectionsQuery.isError || rosterMissing ? (
              // An *empty pool*, on the other hand, is a claim about the server's
              // answer. The header already says what went wrong, and says it
              // whether the list came back empty or merely short. What must not
              // happen here is the line below: with nothing loaded, "everyone is
              // already in this group" is the same lie in stronger terms — the
              // truth is that we failed to ask.
              null
            ) : (
              <Text style={styles.message}>
                Everyone you’re connected with is already in this group.
              </Text>
            )
          }
        />

        <View style={[styles.footer, { paddingBottom: FOOTER_PAD + insets.bottom }]}>
          <Text style={styles.count}>
            {chosen.length === 0 ? 'Select who to invite' : `${chosen.length} selected`}
          </Text>
          <Pressable
            onPress={sendInvites}
            disabled={chosen.length === 0 || invite.isPending}
            accessibilityRole="button"
            accessibilityLabel="Invite"
            style={({ pressed }) => [
              styles.inviteBtn,
              (chosen.length === 0 || invite.isPending) && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.inviteLabel}>{invite.isPending ? 'Inviting…' : 'Invite'}</Text>
          </Pressable>
        </View>
      </KeyboardAvoider>
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
  banner: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    textAlign: 'center',
    fontSize: fontSize.sm,
    color: colors.danger,
    lineHeight: 20,
  },
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
