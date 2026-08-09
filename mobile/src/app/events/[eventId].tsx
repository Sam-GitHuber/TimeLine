/**
 * The event detail screen (`/events/[eventId]`) — the deep-link a notification
 * opens, and where members read an event and take part: see the dimension chips,
 * vote in polls, and RSVP.
 *
 * A **root-stack sibling** (not under the tab group), like `post/` and `u/`, so
 * it covers the tab bar full-screen — the expected native behaviour for a pushed
 * detail. An event you're not connected to the organiser of is a **404**; it
 * renders as "not available" rather than leaking that it exists (events.md).
 *
 * **E3b was read + participate.** **E3c-a** added the organiser's *set* surface —
 * the chip **Set/Change** → the contextual `DimensionEditor` → **finalise**, plus
 * **cancel/delete** — and **E3c-b** the poll lifecycle, so `PollTally` is handed
 * the organiser's controls (open/edit/close/reopen/remove) as well as voting.
 * Ported from `frontend/src/pages/EventPage.jsx`.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api, ApiError, serverMessage, WENT_WRONG } from '@/api';
import { Avatar } from '@/components/Avatar';
import { DimensionChips } from '@/components/events/DimensionChips';
import { EventPhotos } from '@/components/events/EventPhotos';
import { KeyboardAwareScroll } from '@/components/KeyboardAvoider';
import { DimensionEditor, type PollDraft } from '@/components/events/DimensionEditor';
import { PollTally, type EditPollPayload, type FinaliseArg } from '@/components/events/PollTally';
import { RsvpBar } from '@/components/events/RsvpBar';
import { CommentThread } from '@/components/CommentThread';
import { ReactionBar } from '@/components/ReactionBar';
import { formatEventWhen } from '@/eventFormat';
import { mirrorEventSeen } from '@/seenMirror';
import { useAndroidBack } from '@/useAndroidBack';
import { useHoldSwipeBack, useWriteHold, WriteHoldProvider } from '@/writeHold';
import { colors, fontSize, fonts, radius, spacing } from '@/theme';

type PollDimension = 'date' | 'time' | 'location' | 'custom';
/** Which chip's editor is open, and whether it's setting a value or opening a poll. */
type Editing = { dimension: PollDimension; mode: 'set' | 'poll' };

/**
 * Whether an organiser-pasted location link is safe to open. `Linking.openURL`
 * will fire *any* scheme — `javascript:`, `tel:`, a custom app deep-link — so a
 * link is only shown/opened when it's plainly **http(s)**. The value is
 * attacker-controlled (any group member can organise an event), so this guards
 * both the affordance and the tap.
 */
function isSafeHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

/** A brand-new event with nothing set and no polls — shows the first-step hint. */
function nothingDecided(event: { event_date: string | null; start_time: string | null; location_name: string; polls: unknown[] }): boolean {
  return (
    !event.event_date &&
    !event.start_time &&
    !event.location_name &&
    (event.polls ?? []).length === 0
  );
}

export default function EventScreen() {
  const { eventId, comment } = useLocalSearchParams<{
    eventId: string;
    /** From a "replied on your event" push — the comment to open at. */
    comment?: string;
  }>();
  const id = Number(eventId);
  const highlightCommentId = comment ? Number(comment) : null;
  const queryClient = useQueryClient();

  // Which chip's editor is open (organiser's Set/Change/Poll), or null.
  const [editing, setEditing] = useState<Editing | null>(null);

  const eventQuery = useQuery({
    queryKey: ['event', id],
    /**
     * Same viewing-is-seeing mirror as `post/[postId].tsx`, for the event's
     * notifications — and **on the request, not on a render (#318)**, for the
     * reason written out in full over there and in `seenMirror.ts`. In short:
     * `useQuery` returns a cached event synchronously, so an effect gated on
     * `!!event` fired before the mount refetch had asked the server anything,
     * and a refetch that then 404'd left this screen saying the event "may have
     * been cancelled" with the push that would have brought you back already
     * pulled from the tray. A cancelled-then-deleted event is exactly the case
     * that reaches it.
     */
    queryFn: async () => {
      const fetched = await api.getEvent(id);
      mirrorEventSeen(queryClient, id);
      return fetched;
    },
    retry: false,
  });
  const event = eventQuery.data;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['event', id] });
    // The album's own key, so a photo added or removed anywhere refreshes the
    // grid — including the copy a timeline entry's lightbox reads, which shares
    // this key deliberately.
    queryClient.invalidateQueries({ queryKey: ['eventPhotos', id] });
    if (event) {
      // The group's upcoming/past lists and calendars show the same RSVP/vote
      // tallies, dimension values and photo previews, so keep them in step once
      // this write lands.
      queryClient.invalidateQueries({ queryKey: ['groupEvents', event.group.id] });
      queryClient.invalidateQueries({ queryKey: ['groupCalendar', event.group.id] });
      queryClient.invalidateQueries({ queryKey: ['personalCalendar'] });
    }
  };

  const goBack = () => {
    // The control renders unavailable too; this is the backstop.
    if (holding) return;
    if (router.canGoBack()) router.back();
    else if (event) router.replace(`/groups/${event.group.id}`);
    else router.replace('/groups');
  };

  // Handed to `RsvpBar` as `mutateAsync` for the same reason as voting: the
  // guests and note are typed into that component, so a rejection has to reach
  // it to be said out loud (#229). Nothing here renders `rsvp.isError`.
  const rsvp = useMutation({
    mutationFn: (body: Parameters<typeof api.rsvpEvent>[1]) => api.rsvpEvent(id, body),
    onSuccess: invalidate,
  });
  // Voting is the one mutation the tally shows optimistically, so it's handed to
  // `PollTally` as `mutateAsync`: a rejection has to reach the component that put
  // the tick on screen, which rolls it back and states the failure (#227).
  const vote = useMutation({
    mutationFn: ({ pollId, optionIds }: { pollId: number; optionIds: number[] }) =>
      api.votePoll(pollId, optionIds),
    onSuccess: invalidate,
  });
  // The organiser's decision on a dimension (advisory finalise): a built-in value,
  // or an option pinned for a custom poll. Closes any open poll on the dimension.
  const finalise = useMutation({
    mutationFn: (arg: FinaliseArg) => api.finaliseDimension(id, arg),
    onSuccess: () => {
      setEditing(null);
      invalidate();
    },
    onError: (err) => Alert.alert('Couldn’t save', serverMessage(err, WENT_WRONG)),
  });
  // Open a poll on a dimension (organiser). Closes the editor on success.
  const openPoll = useMutation({
    mutationFn: (draft: PollDraft) => api.openPoll(id, draft),
    onSuccess: () => {
      setEditing(null);
      invalidate();
    },
    onError: (err) => Alert.alert('Couldn’t open the poll', serverMessage(err, WENT_WRONG)),
  });
  // Poll lifecycle. Edit is `mutateAsync` so the edit form can await + surface a
  // 409 (voting has started) in place, matching the web.
  const editPoll = useMutation({
    mutationFn: ({ pollId, payload }: { pollId: number; payload: EditPollPayload }) =>
      api.editPoll(pollId, payload),
    onSuccess: invalidate,
  });
  // The rest of the lifecycle. `onSuccess` is the only place the invalidation
  // runs, so before #237 a rejection repainted nothing at all: a close that 404'd
  // (another admin had removed the poll) left it on screen still open, and votes
  // went on arriving into a poll the organiser believed was frozen. Each alert's
  // *title* names which of the three didn't happen — that's where this screen
  // carries the per-state half of connections.md's "Reporting a refused write",
  // since an `Alert` has a title to put it in and the web's inline line doesn't.
  const closePoll = useMutation({
    mutationFn: (pollId: number) => api.closePoll(pollId),
    onSuccess: invalidate,
    onError: (err) => Alert.alert('Couldn’t close the poll', serverMessage(err, WENT_WRONG)),
  });
  const reopenPoll = useMutation({
    mutationFn: (pollId: number) => api.reopenPoll(pollId),
    onSuccess: invalidate,
    onError: (err) => Alert.alert('Couldn’t re-open the poll', serverMessage(err, WENT_WRONG)),
  });
  const deletePoll = useMutation({
    mutationFn: (pollId: number) => api.deletePoll(pollId),
    onSuccess: invalidate,
    onError: (err) => Alert.alert('Couldn’t remove the poll', serverMessage(err, WENT_WRONG)),
  });
  /**
   * Three writes on this screen report themselves **inside their own component
   * and nowhere else** (#256), so leaving mid-flight swallows the answer. All
   * three are handed down as `mutateAsync` for exactly that reason, and none of
   * them has an `onError: Alert.alert` — the rest of this screen's mutations do.
   *
   * - the **RSVP** — the guests and note are typed into `RsvpBar`, which is
   *   where its refusal renders (#229). Tap Going, set 2 guests and a note, tap
   *   Update, leave, and a 403 for a group you were removed from lands nowhere:
   *   you believe you're down for three, and nobody is expecting you.
   * - a **vote** — the tick is optimistic, so `PollTally` has to roll it back
   *   and say so (#227). Leave first and the rollback runs in a dead component;
   *   the tally you come back to reads as "nobody has voted" rather than "your
   *   vote never landed".
   * - a **poll edit** — the 409 ("voting has started") is surfaced in the edit
   *   form in place, which is the whole reason that one is `mutateAsync`.
   *
   * `hold` picks up a **fourth**: a comment edit or reply in the `CommentThread`
   * further down this screen, whose write box is the only renderer of its own
   * refusal too. `CommentNode` holds the routes it owns and forwards up to here
   * for the two it can't see — this screen's Back and the swipe.
   *
   * Hoisted to one predicate read by all the gates below, so they can't drift
   * apart — the shape the web settled on in #300.
   */
  const hold = useWriteHold();
  const holding =
    rsvp.isPending || vote.isPending || editPoll.isPending || hold.held;
  useHoldSwipeBack(holding);

  // Android back closes the open editor rather than the event — the hardware
  // equivalent of its Cancel. Without it, a press meant to back out of a poll
  // you'd started drafting drops you back on the group timeline (#168).
  //
  // One registration for both jobs, not two: RN runs the most recently
  // registered handler first, so a second handler for the hold would order
  // itself by an accident of hook order.
  useAndroidBack(editing !== null || holding, () => {
    if (holding) return;
    setEditing(null);
  });

  // `finalise` is in here too: the tally's per-option Set/Pin is a finalise, so it
  // must disable while one is in flight — otherwise a double-tap fires it twice.
  const pollBusy =
    finalise.isPending ||
    openPoll.isPending ||
    editPoll.isPending ||
    closePoll.isPending ||
    reopenPoll.isPending ||
    deletePoll.isPending;
  // Cancel is the one that lies hardest: nothing on this screen moves until the
  // write lands, so a cancel that failed looked exactly like one that worked —
  // right down to the confirm that promised everyone who RSVP'd would be told.
  // Nobody is notified and the organiser has no reason to doubt it (#237).
  const cancel = useMutation({
    mutationFn: () => api.cancelEvent(id),
    onSuccess: invalidate,
    onError: (err) => Alert.alert('Couldn’t cancel the event', serverMessage(err, WENT_WRONG)),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteEvent(id),
    onSuccess: () => {
      invalidate();
      goBack();
    },
    // A failed delete never runs `goBack`, so you stay on the event you thought
    // you'd deleted — indistinguishable from a slow request, and the natural
    // response is to press it again.
    onError: (err) => Alert.alert('Couldn’t delete the event', serverMessage(err, WENT_WRONG)),
  });

  function confirmCancel() {
    Alert.alert('Cancel this event?', 'People who RSVP’d will be notified.', [
      { text: 'Keep it', style: 'cancel' },
      { text: 'Cancel event', style: 'destructive', onPress: () => cancel.mutate() },
    ]);
  }
  function confirmDelete() {
    Alert.alert('Delete this event?', 'This deletes it for everyone and can’t be undone.', [
      { text: 'Keep it', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => remove.mutate() },
    ]);
  }

  const notFound = eventQuery.error instanceof ApiError && eventQuery.error.status === 404;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.topBar}>
        <Pressable
          onPress={goBack}
          disabled={holding}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={8}
        >
          <Text style={[styles.back, holding && styles.backDisabled]}>
            ← {event ? event.group.name : 'Back'}
          </Text>
        </Pressable>
      </View>

      {/* **A missing event and an unreachable one are different answers**, and
          `notFound || !event` gave the first for both. With `retry: false`, a
          dropped packet or a 500 on the *first* load leaves `isLoading` false
          and no data, so this screen stated the event "may have been cancelled"
          — something the client has no way of knowing — for what was a bad
          connection. Kept apart now, the way `CommentThread` does it and
          `EventPhotos` does two files over. The event we have also outranks a
          failed *refresh* of it: `staleTime` is 0 and every foreground refetches
          this key, and a failed one keeps its data while flipping `status`. */}
      {notFound ? (
        <View style={styles.centre}>
          <Text style={styles.emptyTitle}>Event not available</Text>
          <Text style={styles.emptyBody}>
            It may have been cancelled, or you’re not connected to whoever organised it.
          </Text>
        </View>
      ) : !event ? (
        eventQuery.isError ? (
          <View style={styles.centre}>
            <Text style={styles.emptyTitle}>Couldn’t load this event</Text>
            <Text style={styles.emptyBody}>
              {serverMessage(eventQuery.error, WENT_WRONG)}
            </Text>
            <Pressable style={styles.retry} onPress={() => eventQuery.refetch()}>
              <Text style={styles.retryText}>Try again</Text>
            </Pressable>
          </View>
        ) : (
          <ActivityIndicator color={colors.accent} style={styles.spinner} />
        )
      ) : (
        <KeyboardAwareScroll
          style={styles.fill}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          {/* DimensionEditor's poll-question and place fields sit well down a
              long page, and this screen never had a `KeyboardAvoidingView` to
              convert — under edge-to-edge nothing resizes the window, so without
              help they go behind the keyboard. `KeyboardAwareScroll` also scrolls
              the focused field into view, which matters on a page this long. */}
          <View style={styles.titleRow}>
            <Text style={styles.title}>{event.title}</Text>
            {event.status === 'cancelled' ? (
              <Text style={styles.tagOff}>Cancelled</Text>
            ) : event.is_past ? (
              <Text style={styles.tag}>Happened</Text>
            ) : null}
          </View>

          <Pressable
            style={styles.organiser}
            onPress={() => router.push(`/u/${event.organiser.id}`)}
            accessibilityRole="button"
          >
            <Avatar user={event.organiser} size="xs" />
            <Text style={styles.organiserText}>Organised by {event.organiser.display_name}</Text>
          </Pressable>

          {event.event_date ? (
            <Text style={styles.when}>{formatEventWhen(event)}</Text>
          ) : null}

          {event.description ? <Text style={styles.description}>{event.description}</Text> : null}

          {event.location_name ? (
            <Text style={styles.location}>
              {event.location_name}
              {isSafeHttpUrl(event.location_url) ? (
                <Text
                  style={styles.locationLink}
                  onPress={() => Linking.openURL(event.location_url).catch(() => {})}
                  accessibilityRole="link"
                >
                  {'  ·  link'}
                </Text>
              ) : null}
            </Text>
          ) : null}

          {event.status !== 'cancelled' ? (
            <View style={styles.section}>
              {event.can_manage && nothingDecided(event) && !editing ? (
                <Text style={styles.hint}>
                  Nothing’s set yet. Start with a date — set it now, or open a poll
                  and let the group pick.
                </Text>
              ) : null}
              <DimensionChips
                event={event}
                canManage={event.can_manage}
                onAction={(dimension, mode) => setEditing({ dimension, mode })}
              />
              {editing ? (
                <DimensionEditor
                  key={`${editing.dimension}:${editing.mode}`}
                  dimension={editing.dimension}
                  mode={editing.mode}
                  busy={finalise.isPending || openPoll.isPending}
                  onSet={(dimension, value) => finalise.mutate({ dimension, value })}
                  onPoll={(draft) => openPoll.mutate(draft)}
                  onCancel={() => setEditing(null)}
                />
              ) : null}
              {/* Open a poll on a fresh custom question — the chips only cover the
                  three built-ins, so a custom poll starts here. */}
              {event.can_manage && !editing ? (
                <Pressable
                  onPress={() => setEditing({ dimension: 'custom', mode: 'poll' })}
                  accessibilityRole="button"
                  hitSlop={6}
                  style={styles.askMore}
                >
                  <Text style={styles.askMoreLabel}>+ Ask the group something else</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}

          {(event.polls ?? []).length > 0 ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Polls</Text>
              {event.polls.map((poll) => (
                <PollTally
                  key={poll.id}
                  poll={poll}
                  busy={vote.isPending || pollBusy}
                  onVote={(optionIds) => vote.mutateAsync({ pollId: poll.id, optionIds })}
                  canManage={event.can_manage}
                  onFinalise={(arg) => finalise.mutate(arg)}
                  onEdit={(payload) => editPoll.mutateAsync({ pollId: poll.id, payload })}
                  onClose={() => closePoll.mutate(poll.id)}
                  onReopen={() => reopenPoll.mutate(poll.id)}
                  onDelete={() => deletePoll.mutate(poll.id)}
                />
              ))}
            </View>
          ) : null}

          {event.status !== 'cancelled' ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Are you going?</Text>
              <RsvpBar event={event} busy={rsvp.isPending} onRsvp={(b) => rsvp.mutateAsync(b)} />
            </View>
          ) : null}

          {/* The album. Above the reactions and the thread because it's what
              people come back to a past event for — and, unlike everything
              above it, anyone who can see the event may add to it, whoever
              organised it. Kept on a cancelled event too: a day that turned
              into something else is still a day people photographed. */}
          <EventPhotos eventId={event.id} onChange={invalidate} />

          {/* Reactions and the conversation — the same pair a post carries, in
              the same order. Below the RSVP because deciding whether you're
              going is the screen's job; talking about it is what happens next.

              The chips prune to your connections, unlike the RSVP and poll
              counts above them, which are complete — see events.md. */}
          <View style={styles.section}>
            <ReactionBar
              eventId={event.id}
              reactions={event.reactions}
              trailing={
                event.comment_count > 0 ? (
                  <Text style={styles.commentCount}>
                    {event.comment_count}{' '}
                    {event.comment_count === 1 ? 'comment' : 'comments'}
                  </Text>
                ) : null
              }
            />
            <WriteHoldProvider hold={hold}>
              <CommentThread
                target={{ eventId: event.id, groupId: event.group.id }}
                highlightCommentId={highlightCommentId}
              />
            </WriteHoldProvider>
          </View>

          {/* Cancel/delete — the organiser or a group admin (`can_moderate`).
              Cancel soft-cancels (a tombstone that notifies RSVPs); delete is a
              hard, everyone removal. */}
          {event.can_moderate ? (
            <View style={styles.section}>
              <View style={styles.moderate}>
                {event.status !== 'cancelled' ? (
                  <Pressable
                    onPress={confirmCancel}
                    disabled={cancel.isPending}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.dangerBtn, pressed && styles.pressed]}
                  >
                    <Text style={styles.dangerLabel}>Cancel event</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  onPress={confirmDelete}
                  disabled={remove.isPending}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.dangerBtn, pressed && styles.pressed]}
                >
                  <Text style={styles.dangerLabel}>Delete event</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
        </KeyboardAwareScroll>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  topBar: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  back: { fontSize: fontSize.sm, color: colors.inkFaint, fontWeight: '600' },
  // Unavailable rather than silently declining — a dead Back reads as broken.
  backDisabled: { opacity: 0.4 },
  spinner: { marginTop: spacing.xl },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.lg, fontWeight: '700', color: colors.ink, textAlign: 'center' },
  emptyBody: { fontSize: fontSize.sm, color: colors.inkSoft, textAlign: 'center', lineHeight: 20 },
  // Same outlined button as the profile and group screens' retry.
  retry: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  retryText: { color: colors.ink, fontWeight: '600' },
  fill: { flex: 1 },
  content: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.xxl },
  titleRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  title: { fontSize: fontSize.xl, fontWeight: '700', color: colors.ink, flexShrink: 1 },
  tag: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.inkFaint,
    textTransform: 'uppercase',
  },
  tagOff: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.danger,
    textTransform: 'uppercase',
  },
  organiser: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  organiserText: { fontSize: fontSize.sm, color: colors.inkFaint },
  when: { fontFamily: fonts.mono, fontSize: fontSize.base, color: colors.inkSoft },
  description: { fontSize: fontSize.base, color: colors.inkSoft, lineHeight: 23 },
  location: { fontSize: fontSize.sm, color: colors.inkSoft },
  locationLink: { color: colors.accentDeep, fontWeight: '600' },
  section: {
    marginTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingTop: spacing.md,
    gap: spacing.sm,
  },
  sectionTitle: { fontSize: fontSize.base, fontWeight: '700', color: colors.ink },
  commentCount: { fontSize: fontSize.sm, color: colors.inkFaint },
  hint: { fontSize: fontSize.sm, color: colors.inkSoft, lineHeight: 20, marginBottom: spacing.xs },
  askMore: { marginTop: spacing.sm, alignSelf: 'flex-start' },
  askMoreLabel: { fontSize: fontSize.sm, fontWeight: '700', color: colors.accentDeep },
  moderate: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  dangerBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
  },
  dangerLabel: { fontSize: fontSize.sm, fontWeight: '600', color: colors.danger },
  pressed: { opacity: 0.7 },
});
