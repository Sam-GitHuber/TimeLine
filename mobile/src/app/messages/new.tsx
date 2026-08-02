/**
 * Start a new conversation, or add people to an existing one (Phase 9 E2b).
 * Ported from the web's `NewChatPicker.jsx`, as a full-screen route pushed over
 * the tab bar (the E2 structure decision) rather than a drawer view.
 *
 * Check one or more of your connections, optionally name the chat, and Create:
 *   - one person  → a **1:1** (`openConversation`, get-or-create);
 *   - two+ people → a **group** (`createGroupChat`).
 *
 * The title is what *makes* a chat a group, so the name field only appears once
 * two people are ticked, and a name left over from an untick is ignored rather
 * than sent — see `isGroup` and the `create` mutation.
 *
 * **Add-people mode** (`?addTo=<conversationId>`, from a group thread's Add
 * button): the same picker, but Create *adds* the selected people to that chat
 * (`addParticipants`) and returns to it — no title field, since the chat exists.
 *
 * You can only message people you're connected with, so the pool is
 * `listConnections` — the backend rejects a non-connection anyway (the clique
 * gate, messaging.md). Reuses the People screen's `['connections']` query key, so
 * the two share a cache and can't drift on paging. The **group-scoped** launch
 * (from a group page, pool = members ∩ connections) is E3, not here.
 */

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { api } from '@/api';
import { Avatar } from '@/components/Avatar';
import { KeyboardAvoider } from '@/components/KeyboardAvoider';
import { dedupeById, useFetchAllPages } from '@/lists';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { Conversation, PersonSummary } from '@/types';

const FOOTER_PAD = spacing.sm + 2;

export default function NewChatScreen() {
  const { addTo } = useLocalSearchParams<{ addTo?: string }>();
  const addToId = addTo ? Number(addTo) : null;
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const [term, setTerm] = useState('');
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [title, setTitle] = useState('');

  const goBack = () =>
    router.canGoBack() ? router.back() : router.replace('/messages');

  // All your connections (following `next`), so search covers everyone, not just
  // the first page. Same key + query as the People screen's Connections list.
  // A page that fails stops the walk rather than retrying it forever (#248), so
  // the list can end short of someone you know — which on a picker reads as
  // "you aren't connected to them". The banner below is what stops it saying
  // that, and is the obligation `useFetchAllPages` documents.
  const query = useInfiniteQuery({
    queryKey: ['connections'],
    queryFn: ({ pageParam }) =>
      pageParam ? api.getPage<PersonSummary>(pageParam) : api.listConnections(),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
  });
  useFetchAllPages(query);

  const connections = dedupeById(
    query.data?.pages.flatMap((page) => page.results) ?? []
  );
  const needle = term.trim().toLowerCase();
  const filtered = needle
    ? connections.filter((person) =>
        person.display_name.toLowerCase().includes(needle)
      )
    : connections;

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Only a group has a name, so the field is only offered at two-plus.
  const isGroup = selected.size > 1;

  const create = useMutation({
    mutationFn: (): Promise<Conversation | void> => {
      const ids = [...selected];
      if (addToId) return api.addParticipants(addToId, ids);
      // One person is always a 1:1 — the direct thread the pair already share.
      // A name can only be typed at two-plus (`isGroup`), and one abandoned by
      // an untick is ignored rather than quietly making this `createGroupChat`:
      // that hands you a two-person *group*, which sits off the pair's direct
      // thread and outside `unique_conversation_pair`. Reading the title only
      // on the group path means what's on screen is always what gets sent, and
      // an abandoned name is still there — visible — if you re-tick a second
      // person.
      if (ids.length === 1) return api.openConversation(ids[0]);
      return api.createGroupChat({ participantIds: ids, title: title.trim() });
    },
    onSuccess: (conversation) => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      if (addToId) {
        // Refetch the thread we're returning to so the new members show.
        queryClient.invalidateQueries({ queryKey: ['conversation', addToId] });
        goBack();
      } else {
        // Replace the picker with the new thread, so Back from the thread lands
        // on the Messages list rather than back on this picker.
        router.replace(`/messages/${(conversation as Conversation).id}`);
      }
    },
  });

  const errorMessage =
    create.error instanceof Error
      ? create.error.message
      : addToId
        ? 'Couldn’t add them to this chat.'
        : 'Couldn’t start that chat.';

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.topBar}>
        <Pressable
          onPress={goBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={8}
        >
          <Text style={styles.back}>← Back</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {addToId ? 'Add people' : 'New message'}
        </Text>
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
          keyExtractor={(person) => String(person.id)}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <PersonRow
              person={item}
              checked={selected.has(item.id)}
              onToggle={() => toggle(item.id)}
            />
          )}
          ListHeaderComponent={
            // Above the rows rather than in the empty state, because the case
            // this exists for is the list that *isn't* empty: page one landed
            // and page two didn't, so the names you can see look like all the
            // names there are (#248).
            // Not a `ListMessage`: that one centres itself in the whole list
            // (`flex: 1`), which as a header would push every row off the
            // screen.
            query.isError ? (
              <Text style={[styles.messageText, styles.messageError, styles.banner]}>
                Couldn’t load your connections.
              </Text>
            ) : null
          }
          ListEmptyComponent={
            query.isLoading ? (
              <ListMessage>Loading…</ListMessage>
            ) : query.isError ? (
              // The header already said it, and it says it in both cases.
              null
            ) : connections.length === 0 ? (
              <View style={styles.emptyBlock}>
                <Text style={styles.emptyTitle}>No connections yet</Text>
                <Text style={styles.messageText}>
                  You can only message people you’re connected with — connect with
                  someone first.
                </Text>
              </View>
            ) : (
              <ListMessage>No connections match “{term}”.</ListMessage>
            )
          }
        />

        <View
          style={[styles.footer, { paddingBottom: FOOTER_PAD + insets.bottom }]}
        >
          {!addToId && isGroup && (
            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder="Chat name (optional)"
              placeholderTextColor={colors.inkFaint}
              style={styles.titleInput}
              accessibilityLabel="Chat name"
              // The column's width. Without it the create endpoint silently
              // truncates at 100 and you'd never be told which half you kept —
              // the rename field has capped it since M6, and this is the same
              // field a day earlier.
              maxLength={100}
            />
          )}
          <View style={styles.footerRow}>
            <Text style={styles.count}>
              {selected.size === 0
                ? 'Select at least one connection'
                : `${selected.size} selected`}
            </Text>
            <Pressable
              onPress={() => create.mutate()}
              disabled={selected.size === 0 || create.isPending}
              accessibilityRole="button"
              accessibilityLabel={addToId ? 'Add' : 'Create'}
              style={({ pressed }) => [
                styles.createBtn,
                (selected.size === 0 || create.isPending) && styles.createDisabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.createLabel}>
                {create.isPending
                  ? addToId
                    ? 'Adding…'
                    : 'Creating…'
                  : addToId
                    ? 'Add'
                    : 'Create'}
              </Text>
            </Pressable>
          </View>
          {create.isError && <Text style={styles.error}>{errorMessage}</Text>}
        </View>
      </KeyboardAvoider>
    </SafeAreaView>
  );
}

function PersonRow({
  person,
  checked,
  onToggle,
}: {
  person: PersonSummary;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={person.display_name}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={[styles.check, checked && styles.checkOn]}>
        {checked && <Text style={styles.checkMark}>✓</Text>}
      </View>
      <Avatar user={person} size="md" />
      <Text style={styles.rowName} numberOfLines={1}>
        {person.display_name}
      </Text>
    </Pressable>
  );
}

function ListMessage({
  children,
  error,
}: {
  children: React.ReactNode;
  error?: boolean;
}) {
  return (
    <View style={styles.message}>
      <Text style={[styles.messageText, error && styles.messageError]}>
        {children}
      </Text>
    </View>
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
  title: {
    flex: 1,
    textAlign: 'center',
    fontSize: fontSize.base,
    fontWeight: '700',
    color: colors.ink,
  },
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
  rowName: { flex: 1, fontSize: fontSize.base, fontWeight: '600', color: colors.ink },
  message: { flex: 1, padding: spacing.xl, alignItems: 'center', justifyContent: 'center' },
  messageText: {
    fontSize: fontSize.sm,
    color: colors.inkFaint,
    textAlign: 'center',
    lineHeight: 20,
  },
  messageError: { color: colors.danger },
  banner: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  emptyBlock: {
    flex: 1,
    padding: spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  emptyTitle: { fontSize: fontSize.base, fontWeight: '600', color: colors.ink },
  footer: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingHorizontal: spacing.sm + 2,
    paddingTop: spacing.sm + 2,
    gap: spacing.sm,
  },
  titleInput: {
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.md,
    backgroundColor: colors.raised,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: fontSize.base,
    color: colors.ink,
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  count: { flex: 1, fontSize: fontSize.sm - 1, color: colors.inkFaint },
  createBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  createDisabled: { opacity: 0.4 },
  createLabel: { fontSize: fontSize.sm, fontWeight: '600', color: '#ffffff' },
  pressed: { opacity: 0.7 },
  error: { fontSize: fontSize.sm, color: colors.danger },
});
