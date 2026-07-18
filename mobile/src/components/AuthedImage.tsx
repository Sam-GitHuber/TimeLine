/**
 * An `<Image>` that authenticates.
 *
 * **Why this is needed at all.** Uploaded photos and avatars are real friends'
 * and family's images, so in production they aren't world-readable: Caddy
 * `forward_auth`s every `/media/*` request to `GET /api/media-auth/`, which
 * returns 204 only for a logged-in active member (see feed-and-posts.md and
 * deploy.md). The web app satisfies that automatically — the browser attaches
 * its auth cookie to image requests without being asked.
 *
 * **A native app gets no such help.** `<Image source={{ uri }}>` issues a bare
 * GET with no credentials, so every photo in the feed would come back 401 and
 * render as a blank box. The fix is to attach the Bearer header explicitly,
 * which `expo-image` supports on the source object.
 *
 * So: **use this for anything served from `/media/`** — post photos, avatars,
 * group images. A plain `<Image>` will appear to work in development (Django
 * serves `/media/` openly when `DEBUG` is on — a convenience, not access
 * control) and then break in production. That's a trap worth knowing about.
 */

import { Image, type ImageProps } from 'expo-image';

import { BASE_URL } from '@/api';
import { getCachedAccessToken } from '@/tokens';

type Props = Omit<ImageProps, 'source'> & {
  /** An absolute media URL from the API, or `null` to render nothing. */
  uri: string | null | undefined;
};

export function AuthedImage({ uri, ...props }: Props) {
  if (!uri) return null;

  const token = getCachedAccessToken();

  return (
    <Image
      // Only send the header to our own backend. An absolute URL is under our
      // control today, but leaking a bearer token to some other host because a
      // field changed later is exactly the kind of mistake worth designing out.
      source={
        token && uri.startsWith(BASE_URL)
          ? { uri, headers: { Authorization: `Bearer ${token}` } }
          : { uri }
      }
      {...props}
    />
  );
}
