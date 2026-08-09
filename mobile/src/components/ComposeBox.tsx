/**
 * The live end of the timeline: where you write a post.
 *
 * This caps the top of the feed, and the design does real work here (see
 * docs/design-system.md and feed-and-posts.md). The pulsing "now" node sits at
 * the very tip of the line, your own avatar hangs on the spine just below it —
 * exactly as a poster's avatar marks every other entry — so the live end of the
 * timeline reads like the entries beneath it, rather than a form bolted on top.
 *
 * A post may be text, photos, or both, but not neither — the same rule the
 * server enforces.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { api, serverMessage, WENT_WRONG, type PhotoUpload } from '@/api';
import { usePhotoPicker } from '@/photoSource';
import { Avatar } from './Avatar';
import { NowNode } from './NowNode';
import { SPINE_COLUMN, Spine } from './timeline';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { User } from '@/types';

/**
 * How far down the row the "now" node sits.
 *
 * The node's ring pulses *outward* from it, so it needs clearance above or the
 * animation is clipped by the header above the list. This offset is that
 * clearance — see `NowNode`'s `PING_SCALE`.
 */
const NODE_SIZE = 12;
const NODE_TOP = 10;

const BEAD = 24; // Avatar size="xs"
const BEAD_BORDER = 3; // surface-coloured halo
/**
 * Gap between the "now" tip and your avatar bead.
 *
 * Wider than it needs to be to merely clear the node: "now" and the node are one
 * statement about the present, and your avatar and the text box are a separate
 * one about writing. Crowding them makes the four read as a single stack.
 */
const BEAD_GAP = spacing.md + spacing.xs;

/** Collapsed height of the text box. */
const INPUT_HEIGHT = 44;

/*
 * How the body column lines up with the spine.
 *
 * The spine column has two things on it, and the body has two things beside it,
 * and each pair has to read as one unit — the eye pairs them up whether or not
 * the layout does:
 *
 *   ● now node   ←→  the word "now"    (this *is* now: the live tip of the line)
 *   ◍ your bead  ←→  the text box      (this is you, about to write)
 *
 * Nothing lines two separate columns up automatically, so rather than nudging
 * paddings until it looks right, both centres are computed from the same
 * constants the spine column is built from. Change any of those and the body
 * follows.
 */
const NODE_CENTRE = NODE_TOP + NODE_SIZE / 2;
const BEAD_CENTRE = NODE_TOP + NODE_SIZE + BEAD_GAP + BEAD_BORDER + BEAD / 2;
/**
 * "now" is centred inside a band starting at the top of the body, so the band
 * has to be twice the node's centre for the label to land on it.
 */
const NOW_BAND = 2 * NODE_CENTRE;
/** Top of the text box, so its centre lands on the avatar's. */
const INPUT_TOP = BEAD_CENTRE - INPUT_HEIGHT / 2;
/**
 * What's left between the "now" band and the box. Only ever positive because
 * `BEAD_GAP` holds the bead well clear of the node — if you shrink that gap far
 * enough this goes negative and the two bands overlap.
 */
const INPUT_GAP = INPUT_TOP - NOW_BAND;

/** Mirrors `POST_MAX_LENGTH` / `MAX_IMAGES_PER_POST` in the backend. */
const MAX_LENGTH = 5000;
const MAX_PHOTOS = 10;

export function ComposeBox({
  user,
  onPosted,
  groupId,
}: {
  user: User | null;
  /** Called after a post lands, so the feed can bring it into view. */
  onPosted?: () => void;
  /**
   * When set, the post goes to this group (E3a) instead of the personal feed —
   * `createPost` sends the `group` id, and the group's timeline is one of the
   * lists refreshed on success (see `onSuccess`).
   */
  groupId?: number;
}) {
  const [text, setText] = useState('');
  const [photos, setPhotos] = useState<PhotoUpload[]>([]);
  const { pickPhotos, photoMenu } = usePhotoPicker();
  const queryClient = useQueryClient();

  const { mutate, isPending } = useMutation({
    mutationFn: () => api.createPost(text.trim(), photos, groupId),
    onSuccess: () => {
      setText('');
      setPhotos([]);
      // Put the keyboard away: the thought is finished, and leaving it up means
      // the list resizes under the user a moment later, which reads as a jolt.
      Keyboard.dismiss();
      // Refetch the timelines the new post belongs on, so it appears at the top
      // of each. Invalidating rather than optimistically inserting keeps the
      // client from having to guess the server's shape (ids, timestamps,
      // counts) for a brand-new post.
      //
      // Which lists those are is a rule, not a caller's choice — this used to
      // take an `invalidateKey` prop and each screen passed the one list it was
      // itself showing, so a group post never refreshed the home feed (#275).
      // The rule matches web's (`frontend/src/components/ComposeBox.jsx`):
      //
      // The home feed always refreshes — a group post can surface there via the
      // "include groups" toggle. Then refresh the specific list it landed in:
      // the group's timeline, or (for a personal post) your own profile. A
      // group post is *not* on your profile — `visible_posts` filters
      // `group__isnull=True` there, so the two really are either/or.
      //
      // The keys are bare prefixes, which is what makes them reach the suffixed
      // keys the screens actually use: `['feed', includeGroups]` and
      // `['userPosts', id]`. (`invalidateQueries` prefix-matches — the opposite
      // of `setQueryData`, which needs the exact key, and is why `postCache`
      // reaches these same lists through a `setQueriesData` predicate instead;
      // see feed-and-posts.md.)
      //
      // The one place this is broader than web, which scopes the personal case
      // to `['userPosts', user.pk]`: a bare `['userPosts']` also marks a cached
      // *other* person's profile stale. That costs nothing — the compose box
      // only exists on the home feed and a group page, so no profile query can
      // be observed here, and an unobserved one refetches on its next mount
      // regardless at `staleTime` 0 — and it can't miss your own profile the
      // way `['userPosts', undefined]` would if `user` were ever null.
      //
      // Deliberately *not* a helper in `postCache.ts` alongside
      // `invalidatePostComments`, which is the obvious place to look. That one
      // earns its keep by deriving its keys from the `POST_LIST_KEYS` set it
      // shares with `markPostCommentsSeen`, so the two can't drift — it hits
      // *every* post list, unconditionally. This is the other shape: a new post
      // lands on exactly two of them, and which two depends on `groupId`. There
      // is nothing to derive, so extracting it would move these two lines
      // without buying the guarantee, and would split the rule away from web's
      // copy of it. If a fourth post-list surface is ever added, both this and
      // `POST_LIST_KEYS` need it — that's the cost, and it's why the rule is
      // written out rather than computed.
      queryClient.invalidateQueries({ queryKey: ['feed'] });
      queryClient.invalidateQueries({
        queryKey: groupId ? ['groupPosts', groupId] : ['userPosts'],
      });
      // Inserting a post above whatever you were looking at shifts everything
      // down. Scrolling to the top turns that from an unexplained lurch into a
      // deliberate move that shows you the thing you just wrote.
      onPosted?.();
    },
    onError: (error) => {
      // Keep the text and photos on failure — losing what someone just typed
      // because the network blipped is unforgivable on a phone.
      Alert.alert(
        'Couldn’t post',
        serverMessage(error, WENT_WRONG)
      );
    },
  });

  /**
   * Add photos: take one, or pick from the library.
   *
   * The camera is offered first — on a phone, "add a photo" to what you're
   * writing about right now often means the thing in front of you. Only the
   * library can return several at once, which is why this is a choice rather
   * than a camera button beside a library button.
   *
   * `quality: 0.9` is the one thing here that isn't the shared default: post
   * photos go up as picked, so this is the only compression they get. Chat
   * photos and avatars are re-encoded afterwards and take the full-quality pick.
   */
  async function addPhotos() {
    const assets = await pickPhotos('Add a photo', {
      allowsMultipleSelection: true,
      selectionLimit: MAX_PHOTOS - photos.length,
      quality: 0.9,
    });
    if (!assets) return;

    setPhotos((current) =>
      [
        ...current,
        ...assets.map((asset, index) => ({
          uri: asset.uri,
          // The picker often has no filename (a camera-roll asset isn't a file
          // on disk). The server validates by decoding the bytes, not by
          // extension, so a synthesised name is fine — but it must be *present*,
          // or the multipart part is dropped.
          name: asset.fileName ?? `photo-${Date.now()}-${index}.jpg`,
          type: asset.mimeType ?? 'image/jpeg',
        })),
      ].slice(0, MAX_PHOTOS)
    );
  }

  function removePhoto(uri: string) {
    setPhotos((current) => current.filter((photo) => photo.uri !== uri));
  }

  const canPost = (text.trim() !== '' || photos.length > 0) && !isPending;

  return (
    <View style={styles.row}>
      {/* The spine starts below the "now" tip so the node caps the line rather
          than sitting on an already-drawn stroke, and runs to the bottom of the
          row to meet the first day divider's segment with no seam. */}
      <Spine top={NODE_TOP + NODE_SIZE / 2} />

      <View style={styles.spineColumn}>
        <NowNode />
        <View style={styles.bead}>
          <Avatar user={user} size="xs" />
        </View>
      </View>

      <View style={styles.body}>
        {/* Where a post shows its clock time, the composer says "now" — the
            live end of the timeline, labelled the same way as every entry
            below it. It sits level with the pulsing node, because the node is
            what "now" is naming. */}
        <View style={styles.nowBand}>
          <Text style={styles.now}>now</Text>
        </View>

        <TextInput
          accessibilityLabel="What's happening?"
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder="What's happening?"
          placeholderTextColor={colors.inkFaint}
          multiline
          maxLength={MAX_LENGTH}
          editable={!isPending}
        />

        {photos.length > 0 ? (
          <View style={styles.thumbs}>
            {photos.map((photo, index) => (
              <View key={photo.uri}>
                {/* A local file:// URI, not our media host — a plain Image is
                    right here; AuthedImage would attach a pointless header. */}
                <Image source={{ uri: photo.uri }} style={styles.thumb} />
                <Pressable
                  style={styles.remove}
                  onPress={() => removePhoto(photo.uri)}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove photo ${index + 1}`}
                  hitSlop={6}
                >
                  <Text style={styles.removeText}>×</Text>
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}

        <View style={styles.actions}>
          <Pressable
            onPress={addPhotos}
            disabled={isPending || photos.length >= MAX_PHOTOS}
            accessibilityRole="button"
            accessibilityLabel="Add photos"
            hitSlop={6}
          >
            <Text
              style={[
                styles.addPhotos,
                (isPending || photos.length >= MAX_PHOTOS) && styles.disabled,
              ]}
            >
              {photos.length > 0
                ? `${photos.length} photo${photos.length === 1 ? '' : 's'}`
                : 'Add photos'}
            </Text>
          </Pressable>

          <Pressable
            style={({ pressed }) => [
              styles.post,
              pressed && styles.postPressed,
              !canPost && styles.disabled,
            ]}
            onPress={() => mutate()}
            disabled={!canPost}
            accessibilityRole="button"
          >
            {isPending ? (
              <ActivityIndicator color={colors.raised} size="small" />
            ) : (
              <Text style={styles.postText}>Post</Text>
            )}
          </Pressable>
        </View>
      </View>

      {/* The source sheet. `null` on iOS, where the sheet is native. */}
      {photoMenu}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    paddingRight: spacing.md,
    // No bottom margin or divider rule: a margin would leave a stretch of row
    // the spine can't be drawn over (margins sit outside the padding box), which
    // shows up as a break in the line right under the compose box.
    paddingBottom: spacing.lg,
  },
  // A fixed band centred on the node, so the label's own line height can't
  // shift the text box out of line with the avatar below it.
  nowBand: { height: NOW_BAND, justifyContent: 'center' },
  now: {
    fontSize: fontSize.sm,
    color: colors.accent,
    fontWeight: '600',
  },
  spineColumn: { width: SPINE_COLUMN, alignItems: 'center', paddingTop: NODE_TOP },
  bead: {
    marginTop: BEAD_GAP,
    borderWidth: BEAD_BORDER,
    borderColor: colors.surface,
    borderRadius: radius.pill,
  },
  body: {
    flex: 1,
    paddingLeft: spacing.sm,
  },
  input: {
    marginTop: INPUT_GAP,
    minHeight: INPUT_HEIGHT,
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm + 2,
    paddingBottom: spacing.sm + 2,
    fontSize: fontSize.base,
    color: colors.ink,
  },
  thumbs: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  thumb: { width: 72, height: 72, borderRadius: radius.md, backgroundColor: colors.line },
  remove: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeText: { color: colors.raised, fontSize: 15, lineHeight: 18, fontWeight: '600' },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
  },
  addPhotos: { fontSize: fontSize.sm, color: colors.accent, fontWeight: '600' },
  post: {
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    minWidth: 76,
    alignItems: 'center',
  },
  postPressed: { backgroundColor: colors.accentDeep },
  postText: { color: colors.raised, fontWeight: '600', fontSize: fontSize.sm },
  disabled: { opacity: 0.4 },
});
