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
import * as ImagePicker from 'expo-image-picker';
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

import { api, type PhotoUpload } from '@/api';
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
  invalidateKey = ['feed'],
}: {
  user: User | null;
  /** Called after a post lands, so the feed can bring it into view. */
  onPosted?: () => void;
  /**
   * When set, the post goes to this group (E3a) instead of the personal feed —
   * `createPost` sends the `group` id and `invalidateKey` should be the group's
   * timeline query so the new post appears there, not on the home feed.
   */
  groupId?: number;
  invalidateKey?: readonly unknown[];
}) {
  const [text, setText] = useState('');
  const [photos, setPhotos] = useState<PhotoUpload[]>([]);
  const queryClient = useQueryClient();

  const { mutate, isPending } = useMutation({
    mutationFn: () => api.createPost(text.trim(), photos, groupId),
    onSuccess: () => {
      setText('');
      setPhotos([]);
      // Put the keyboard away: the thought is finished, and leaving it up means
      // the list resizes under the user a moment later, which reads as a jolt.
      Keyboard.dismiss();
      // Refetch the timeline so the new post appears at the top. Invalidating
      // rather than optimistically inserting keeps the client from having to
      // guess the server's shape (ids, timestamps, counts) for a brand-new post.
      queryClient.invalidateQueries({ queryKey: invalidateKey });
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
        error instanceof Error ? error.message : 'Something went wrong.'
      );
    },
  });

  async function pickPhotos() {
    // No explicit permission request: the modern iOS picker runs out of process
    // and returns only what the user picked, so it needs no library access.
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: MAX_PHOTOS - photos.length,
      quality: 0.9,
    });
    if (result.canceled) return;

    setPhotos((current) =>
      [
        ...current,
        ...result.assets.map((asset, index) => ({
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
            onPress={pickPhotos}
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
