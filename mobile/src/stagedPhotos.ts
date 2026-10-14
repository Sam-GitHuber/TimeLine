/**
 * Photos waiting on a composer for you to hit Send (Phase 9b M7, then #400).
 *
 * Shared by the transcript's composer and the reply strand's, so pasting a
 * picture works the same in both — the strand is where you'd most often answer
 * "send me that photo", and a paste that only worked behind the blur would be
 * the one composer that quietly doesn't.
 *
 * Held as screen state, not in the outbox: nothing here has been sent yet, and
 * the outbox is for messages that are *on their way*.
 *
 * **Several at once, sent as several messages.** A paste can carry more than one
 * image, and the server takes one attachment per message
 * (`MESSAGE_ATTACHMENTS_MAX`) — which is also the better chat shape, since each
 * photo gets its own bubble, reactions, replies and delete. So the composer
 * holds a list and the send splits it; see `queueSend` on the thread screen for
 * where the words go.
 *
 * 🔒 **Every photo goes through `prepareChatPhoto`, pasted or picked.** That is
 * where it's downscaled and its EXIF — including the GPS coordinates a phone
 * stamps on every shot — is stripped by re-encoding from raw pixels. The server
 * does none of that for chat photos, on purpose (see `chatPhotos.ts`), so a
 * paste that skipped it would send everyone in the chat the place the picture
 * was taken. A pasted file is exactly as likely to carry that as a picked one:
 * copying from Photos copies the original.
 */

import type { PastedFile } from '@mattermost/react-native-paste-input';
import { useCallback, useRef, useState } from 'react';
import { Alert } from 'react-native';

import { prepareChatPhoto } from '@/chatPhotos';
import type { OutgoingPhoto } from '@/outbox';

/**
 * The most photos one composer will hold.
 *
 * Each becomes its own message, so this is really "how many messages one tap of
 * Send can produce" — enough for a handful of holiday pictures, not so many that
 * a stray paste of a whole album floods a family chat with uploads nobody meant
 * to send.
 */
export const MAX_STAGED_PHOTOS = 10;

/** An image to prepare: a local URI, plus its size if the source knew it. */
export type PhotoSource = { uri: string; width?: number; height?: number };

/**
 * The images in a paste, in the order they were pasted.
 *
 * A paste can carry anything the pasteboard holds — a video from Photos, a PDF
 * from Files. Only images can become a chat photo; the rest are dropped here
 * rather than handed to the manipulator, which would fail on them with a less
 * honest message ("couldn't use that photo" about something that wasn't one).
 */
export function pastedImages(files: PastedFile[] | null | undefined): PhotoSource[] {
  return (files ?? [])
    .filter((file) => file.type?.startsWith('image/') && !!file.uri)
    .map((file) => ({ uri: file.uri }));
}

export function useStagedPhotos() {
  const [photos, setPhotos] = useState<OutgoingPhoto[]>([]);
  /** How many are still being resized and stripped — drawn as placeholders. */
  const [preparing, setPreparing] = useState(0);
  /**
   * The count `add` checks the cap against, kept in a ref so two pastes in quick
   * succession can't each read a stale count from their render and between them
   * stage more than the cap.
   */
  const held = useRef(0);
  /**
   * Bumped by `clear`, so a photo still preparing when the composer was cleared
   * — Android back, a sign-out — doesn't land on it a second later, after you'd
   * dismissed it.
   */
  const generation = useRef(0);

  const add = useCallback(async (sources: PhotoSource[]) => {
    if (sources.length === 0) return;
    const room = Math.max(0, MAX_STAGED_PHOTOS - held.current);
    const taken = sources.slice(0, room);
    if (taken.length < sources.length) {
      Alert.alert(
        `You can send up to ${MAX_STAGED_PHOTOS} photos at once`,
        taken.length === 0
          ? 'Send these first, then add more.'
          : `Only the first ${taken.length} were added.`
      );
    }
    if (taken.length === 0) return;

    const mine = generation.current;
    held.current += taken.length;
    setPreparing((n) => n + taken.length);
    let failed = 0;
    // One at a time rather than all at once: each prepare decodes a full-size
    // photo, and ten of those in parallel on an older phone is a memory spike
    // for no gain. In order, too, so they're staged — and sent — in the order
    // they were pasted.
    for (const source of taken) {
      let prepared: OutgoingPhoto | null = null;
      try {
        prepared = await prepareChatPhoto(source.uri, source.width, source.height);
      } catch {
        failed += 1;
      }
      if (generation.current !== mine) return;
      setPreparing((n) => n - 1);
      if (prepared) {
        const photo = prepared;
        setPhotos((current) => [...current, photo]);
      } else {
        held.current -= 1;
      }
    }
    if (failed > 0) {
      Alert.alert(
        failed === 1 ? 'Couldn’t use that photo' : `Couldn’t use ${failed} of those photos`,
        'Something went wrong preparing it. Try another one.'
      );
    }
  }, []);

  /**
   * The composer's `onPaste`. Only called for a paste with files in it — a
   * paste of text goes into the input as it always did.
   */
  const onPaste = useCallback(
    (error: string | null | undefined, files: PastedFile[]) => {
      if (error) {
        Alert.alert('Couldn’t paste that', 'Try copying it again.');
        return;
      }
      const images = pastedImages(files);
      if (images.length === 0) {
        Alert.alert(
          'Only photos can be pasted here',
          'Videos and other files can’t be sent in a message yet.'
        );
        return;
      }
      add(images).catch(() => {});
    },
    [add]
  );

  const remove = useCallback((index: number) => {
    held.current -= 1;
    setPhotos((current) => current.filter((_, i) => i !== index));
  }, []);

  const clear = useCallback(() => {
    generation.current += 1;
    held.current = 0;
    setPhotos([]);
    setPreparing(0);
  }, []);

  return { photos, preparing: preparing > 0, preparingCount: preparing, add, onPaste, remove, clear };
}
