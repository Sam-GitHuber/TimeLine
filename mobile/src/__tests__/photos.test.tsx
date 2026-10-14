/**
 * How a post's photos are laid out, and the full-screen viewer.
 *
 * Two things here are worth pinning down, because both are easy to regress and
 * both are about the timeline staying readable:
 *
 * 1. **A post with several photos uses a two-column grid.** A ten-photo post
 *    rendered full-width is screens of scrolling for one entry, which buries
 *    everything else — the reason the grid exists at all. A lone photo keeps its
 *    natural shape.
 * 2. **Tapping a photo opens the viewer on *that* photo.** Opening on the first
 *    one regardless is the classic bug, and it's invisible until you tap the
 *    third photo of a set.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Directory, File } from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library/legacy';
import * as Sharing from 'expo-sharing';
import { Alert, Dimensions, Linking } from 'react-native';
import { State } from 'react-native-gesture-handler';

import { BASE_URL } from '@/api';
import { PhotoLightbox } from '@/components/PhotoLightbox';
import { PostCard } from '@/components/PostCard';
import { saveTokens } from '@/tokens';
import type { Post, PostImage } from '@/types';

// The card navigates on tap; there's no router in a unit test, and where it
// navigates to is `postDetail`'s subject, not this file's.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
}));

// PostCard's ⋯ menu reads the current user (owner check). A fixed stub avoids
// wrapping every render here in an AuthProvider — pk 99 is nobody in these
// fixtures, so the menu offers "Report", which this file doesn't exercise.
jest.mock('@/auth', () => ({
  ...jest.requireActual('@/auth'),
  useAuth: () => ({ user: { pk: 99, display_name: 'Test Viewer' } }),
}));

function makeImage(id: number): PostImage {
  return {
    id,
    image: `https://example.test/media/full-${id}.jpg`,
    thumbnail: `https://example.test/media/thumb-${id}.jpg`,
    width: 1600,
    height: 1200,
  };
}

function makePost(images: PostImage[]): Post {
  return {
    id: 1,
    author: { id: 1, display_name: 'Alice Anderson', avatar_thumb: null },
    text: 'A day out',
    images,
    group: null,
    reactions: [],
    comment_count: 0,
    new_comment_count: 0,
    created_at: '2026-07-18T10:00:00Z',
    edited_at: null,
  };
}

async function renderPost(images: PostImage[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return await render(
    <QueryClientProvider client={queryClient}>
      <PostCard post={makePost(images)} />
    </QueryClientProvider>
  );
}

/** The photo tiles, found by the label the tap target announces. */
function photoTiles(count: number) {
  return Array.from({ length: count }, (_, i) =>
    screen.getByLabelText(`View photo ${i + 1} of ${count} from Alice Anderson`)
  );
}

describe('post photos', () => {
  it('gives a lone photo its natural shape, full width', async () => {
    await renderPost([makeImage(1)]);

    const [tile] = photoTiles(1);
    // Full width — not half of a two-column grid.
    expect(tile).toHaveStyle({ width: '100%' });
  });

  it('lays several photos out two to a row', async () => {
    await renderPost([makeImage(1), makeImage(2), makeImage(3)]);

    // Every tile is half-width, including the odd third one: it sits alone on
    // the second row rather than stretching back out to full width, which is
    // what keeps the grid reading as a grid.
    for (const tile of photoTiles(3)) {
      expect(tile).toHaveStyle({ width: '50%' });
    }
  });

  it('opens the viewer on the photo that was tapped, and closes again', async () => {
    await renderPost([makeImage(1), makeImage(2), makeImage(3)]);

    // Closed to begin with.
    expect(screen.queryByLabelText('Close photo viewer')).toBeNull();

    await fireEvent.press(photoTiles(3)[2]);

    // The counter is the readable proof of *which* photo it landed on.
    expect(screen.getByText('3 / 3')).toBeTruthy();

    await fireEvent.press(screen.getByLabelText('Close photo viewer'));
    expect(screen.queryByLabelText('Close photo viewer')).toBeNull();
  });

  it('does not offer a counter for a single photo', async () => {
    await renderPost([makeImage(1)]);

    await fireEvent.press(photoTiles(1)[0]);

    expect(screen.getByLabelText('Close photo viewer')).toBeTruthy();
    expect(screen.queryByText('1 / 1')).toBeNull();
  });

  it('draws every one of a post’s photos, with no "+N" tile', async () => {
    // 🔒 `PhotoGrid` is shared with an event's album, which caps its tiles and
    // hands the overflow to the *album* rather than to the viewer. A post has
    // no album to hand anything to: it's one bounded set, always sent whole, so
    // it must keep drawing every tile and opening every one of them.
    await renderPost([1, 2, 3, 4, 5].map(makeImage));

    const tiles = photoTiles(5);
    expect(tiles).toHaveLength(5);
    expect(screen.queryByText(/^\+\d+$/)).toBeNull();

    await fireEvent.press(tiles[4]);
    expect(screen.getByText('5 / 5')).toBeTruthy();
  });
});

// --- The viewer's chrome ----------------------------------------------------
//
// Shared by every screen that opens a photo — a post, a chat message, an event's
// album — which is exactly why these two are worth pinning: a tweak made for one
// of them lands on all three.

function makeAlbumPhoto(id: number) {
  return {
    ...makeImage(id),
    uploader: { id: 2, display_name: 'Ada Lovelace', avatar_thumb: null },
    created_at: '2026-06-01T10:00:00Z',
    can_delete: false,
  };
}

describe('the photo viewer', () => {
  it('keeps the close button a square 44pt target', async () => {
    // Apple's minimum, and a circle only while it stays square: a `minWidth`
    // plus horizontal padding (added for the album's worded Remove, which sits
    // in the same row) ovalised the × on every screen this viewer serves.
    await render(
      <PhotoLightbox images={[makeImage(1)]} initialIndex={0} onClose={jest.fn()} />
    );

    expect(screen.getByLabelText('Close photo viewer')).toHaveStyle({
      width: 44,
      height: 44,
    });
  });

  it('never lets a long name push the counter off the pill', async () => {
    // 🔒 The caption and the counter shared one `numberOfLines={1}`, so a long
    // uploader name ellipsized "1 / 3" away entirely — on an album, where the
    // caption exists and the counter matters most.
    await render(
      <PhotoLightbox
        images={[1, 2, 3].map(makeAlbumPhoto)}
        initialIndex={0}
        onClose={jest.fn()}
        captionFor={() => 'Bartholomew Fitzwilliam-Featherstonehaugh III'}
      />
    );

    // Two nodes, not one string: only the name may be truncated.
    expect(
      screen.getByText('Bartholomew Fitzwilliam-Featherstonehaugh III')
    ).toBeTruthy();
    expect(screen.getByText('1 / 3')).toBeTruthy();
  });
});

// --- Zoom, save and share (#396) -------------------------------------------
//
// Shared by every screen that opens a photo, deliberately: a chat photo, a
// post's and an album's all get all three.

/** A photo served by our own backend, so the download carries the token. */
function ourPhoto(id: number): PostImage {
  return {
    ...makeImage(id),
    image: `${BASE_URL}/media/posts/abc${id}.jpg`,
  };
}

async function renderViewer(images: PostImage[] = [ourPhoto(1)]) {
  return await render(
    <PhotoLightbox images={images} initialIndex={0} onClose={jest.fn()} />
  );
}

const download = File.downloadFileAsync as jest.Mock;

describe('saving and sharing a photo', () => {
  it('saves the full-size photo to the library with add-only access', async () => {
    await saveTokens({ access: 'access-1', refresh: 'refresh-1' });
    await renderViewer();

    await fireEvent.press(screen.getByLabelText('Save photo'));

    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy());
    // `true` is write-only: "add photos", never "read your library".
    expect(MediaLibrary.getPermissionsAsync).toHaveBeenCalledWith(true);
    // 🔒 The full-size `image`, not the thumbnail, fetched with the bearer
    // header — /media/ is forward-auth'd, so a bare fetch saves a 401 page.
    expect(download).toHaveBeenCalledWith(
      `${BASE_URL}/media/posts/abc1.jpg`,
      expect.objectContaining({ uri: 'file:///cache/photo-viewer/abc1.jpg' }),
      expect.objectContaining({ headers: { Authorization: 'Bearer access-1' } })
    );
    expect(MediaLibrary.saveToLibraryAsync).toHaveBeenCalledWith(
      'file:///cache/photo-viewer/abc1.jpg'
    );
  });

  it('leaves no copy of the photo behind in the cache', async () => {
    // 🔒 A friend's full-size photo sitting in the app's cache would outlive
    // the post it came from — the same leak as Save, without anyone choosing
    // it. The folder is emptied before every download, and a save deletes its
    // file once the library has its own.
    await renderViewer();

    await fireEvent.press(screen.getByLabelText('Save photo'));

    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy());
    expect((Directory as unknown as { emptied: string[] }).emptied).toEqual([
      'file:///cache/photo-viewer',
    ]);
    expect((File as unknown as { deleted: string[] }).deleted).toEqual([
      'file:///cache/photo-viewer/abc1.jpg',
    ]);
  });

  it('asks the OS first, and says nothing more when the answer is no', async () => {
    (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({
      granted: false,
      canAskAgain: true,
    });
    (MediaLibrary.requestPermissionsAsync as jest.Mock).mockResolvedValueOnce({
      granted: false,
      canAskAgain: false,
    });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await renderViewer();

    await fireEvent.press(screen.getByLabelText('Save photo'));

    await waitFor(() =>
      expect(MediaLibrary.requestPermissionsAsync).toHaveBeenCalledWith(true)
    );
    // Someone who just tapped "Don't Allow" doesn't need a second dialog
    // pushing Settings at them.
    expect(alert).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(screen.getByText('Save')).toBeTruthy();
  });

  it('never sends the token to a host that isn’t ours', async () => {
    await saveTokens({ access: 'access-1', refresh: 'refresh-1' });
    await renderViewer([makeImage(1)]);

    await fireEvent.press(screen.getByLabelText('Save photo'));

    await waitFor(() => expect(MediaLibrary.saveToLibraryAsync).toHaveBeenCalled());
    expect(download.mock.calls[0][2].headers).toBeUndefined();
  });

  it('points at Settings, and downloads nothing, when access was refused before', async () => {
    (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({
      granted: false,
      canAskAgain: false,
    });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue();
    await renderViewer();

    await fireEvent.press(screen.getByLabelText('Save photo'));

    await waitFor(() => expect(alert).toHaveBeenCalled());
    // The OS won't show its prompt again, so there's nothing to request.
    expect(MediaLibrary.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(MediaLibrary.saveToLibraryAsync).not.toHaveBeenCalled();
    // The OS won't ask twice, so the alert's way forward is Settings.
    const buttons = alert.mock.calls[0][2]!;
    buttons.find((button) => button.text === 'Open Settings')!.onPress!();
    expect(openSettings).toHaveBeenCalled();
    // And the button is back to a plain Save, not stuck mid-spin.
    expect(screen.getByText('Save')).toBeTruthy();
  });

  it('says so when the save fails, and offers Save again', async () => {
    download.mockRejectedValueOnce(new Error('offline'));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await renderViewer();

    await fireEvent.press(screen.getByLabelText('Save photo'));

    await waitFor(() =>
      expect(alert).toHaveBeenCalledWith('Couldn’t save', expect.any(String))
    );
    expect(screen.getByText('Save')).toBeTruthy();
  });

  it('shares the photo on screen through the system share sheet', async () => {
    await renderViewer([ourPhoto(1), ourPhoto(2)]);

    await fireEvent.press(screen.getByLabelText('Share photo'));

    await waitFor(() =>
      expect(Sharing.shareAsync).toHaveBeenCalledWith(
        'file:///cache/photo-viewer/abc1.jpg',
        expect.objectContaining({ mimeType: 'image/*' })
      )
    );
  });

  it('keeps "Saved" on the photo that was saved', async () => {
    // 🔒 The confirmation belonged to the viewer, so swiping on inside its two
    // seconds told you the *next* photo was saved too.
    await renderViewer([ourPhoto(1), ourPhoto(2)]);

    await fireEvent.press(screen.getByLabelText('Save photo'));
    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy());

    await swipeTo(1);
    expect(screen.getByText('2 / 2')).toBeTruthy();
    expect(screen.getByText('Save')).toBeTruthy();

    await swipeTo(0);
    expect(screen.getByText('Saved')).toBeTruthy();
  });
});

/** Settle the pager on page `i`, the way a finished swipe reports it. */
async function swipeTo(i: number) {
  await fireEvent(screen.getByTestId('photo-pager'), 'momentumScrollEnd', {
    nativeEvent: { contentOffset: { x: i * Dimensions.get('window').width, y: 0 } },
  });
}

/** The first page's live transform, as `{ scale, x, y }`. */
function firstPhotoZoom() {
  const style = [screen.getAllByTestId('photo-pan')[0].props.style].flat(Infinity);
  const transform = Object.assign(
    {},
    ...style.flatMap((entry: { transform?: object[] } | null) => entry?.transform ?? [])
  );
  return { scale: transform.scale, x: transform.translateX, y: transform.translateY };
}

/** Post one handler's raw event to the view under it. */
async function post(
  testID: string,
  kind: 'gestureHandlerStateChange' | 'gestureHandlerEvent',
  nativeEvent: object
) {
  const view = screen.getAllByTestId(testID)[0];
  await fireEvent(view, kind, { nativeEvent: { handlerTag: view.props.handlerTag, ...nativeEvent } });
}

/**
 * Pinch the photo out to `factor` about its centre, and let go. Events are
 * posted to the view under the handler, as `thread.test.tsx`'s swipe does —
 * including the redraw-first, for the same reason: the handler stamps its real
 * tag on the view only from the second render.
 */
async function pinch(factor: number, rerender: () => Promise<void>) {
  await rerender();
  const view = screen.getAllByTestId('photo-pinch')[0];
  const { handlerTag } = view.props;
  const centre = { focalX: 200, focalY: 400 };
  await fireEvent(view, 'gestureHandlerStateChange', {
    nativeEvent: { handlerTag, oldState: State.BEGAN, state: State.ACTIVE, scale: 1, ...centre },
  });
  await fireEvent(view, 'gestureHandlerEvent', {
    nativeEvent: { handlerTag, state: State.ACTIVE, scale: factor, ...centre },
  });
  await fireEvent(view, 'gestureHandlerStateChange', {
    nativeEvent: { handlerTag, oldState: State.ACTIVE, state: State.END, scale: factor, ...centre },
  });
}

async function doubleTap() {
  const view = screen.getAllByTestId('photo-double-tap')[0];
  const { handlerTag } = view.props;
  await fireEvent(view, 'gestureHandlerStateChange', {
    nativeEvent: { handlerTag, oldState: State.BEGAN, state: State.ACTIVE, x: 200, y: 400 },
  });
}

describe('zooming a photo', () => {
  function pagerScrolls() {
    return screen.getByTestId('photo-pager').props.scrollEnabled;
  }

  it('stops the pager swiping while zoomed in, and frees it on the way out', async () => {
    // 🔒 Swipe pages at 1×, pans when zoomed — the two drags must never both
    // be live, or a pan across a zoomed photo flips to the next one.
    const images = [ourPhoto(1), ourPhoto(2)];
    const view = await renderViewer(images);
    const rerender = () =>
      view.rerender(<PhotoLightbox images={images} initialIndex={0} onClose={jest.fn()} />);

    expect(pagerScrolls()).toBe(true);

    await pinch(2, rerender);
    expect(pagerScrolls()).toBe(false);

    // A double tap on a zoomed photo goes back to fit, and the pager with it.
    await doubleTap();
    expect(pagerScrolls()).toBe(true);
  });

  it('treats a pinch let go just past fit as no zoom at all', async () => {
    const images = [ourPhoto(1), ourPhoto(2)];
    const view = await renderViewer(images);
    const rerender = () =>
      view.rerender(<PhotoLightbox images={images} initialIndex={0} onClose={jest.fn()} />);

    await pinch(1.02, rerender);

    expect(pagerScrolls()).toBe(true);
  });

  it('zooms in on a double tap', async () => {
    const images = [ourPhoto(1), ourPhoto(2)];
    const view = await renderViewer(images);
    await view.rerender(<PhotoLightbox images={images} initialIndex={0} onClose={jest.fn()} />);

    await doubleTap();

    expect(pagerScrolls()).toBe(false);
  });
});

describe('zooming a photo, when gestures overlap', () => {
  const centre = { focalX: 375, focalY: 667 };

  async function mount(images: PostImage[]) {
    const view = await renderViewer(images);
    // The redraw that publishes the handlers' real tags — see `pinch` above.
    await view.rerender(<PhotoLightbox images={images} initialIndex={0} onClose={jest.fn()} />);
    return view;
  }

  it('grows from the scale the pinch had already reached when it took over', async () => {
    // 🔒 A pinch activates only after the fingers have moved, so its first
    // reading is already past 1. Multiplying by it raw jumped the photo.
    await mount([ourPhoto(1)]);

    await post('photo-pinch', 'gestureHandlerStateChange', {
      oldState: State.BEGAN, state: State.ACTIVE, scale: 1.1, ...centre,
    });
    await post('photo-pinch', 'gestureHandlerEvent', { state: State.ACTIVE, scale: 1.1, ...centre });
    expect(firstPhotoZoom().scale).toBe(1);

    await post('photo-pinch', 'gestureHandlerEvent', { state: State.ACTIVE, scale: 2.2, ...centre });
    expect(firstPhotoZoom().scale).toBeCloseTo(2);
  });

  it('doesn’t count a drag twice when a second finger starts a pinch', async () => {
    // 🔒 Pan and pinch run together and both anchored on one shared resting
    // point; the pinch moved it, the pan kept adding its whole travel to it,
    // and the photo jumped by the drag so far.
    await mount([ourPhoto(1)]);
    await pinch(3, async () => {});
    const before = firstPhotoZoom();

    await post('photo-pan', 'gestureHandlerStateChange', {
      oldState: State.BEGAN, state: State.ACTIVE, translationX: 10, translationY: 0,
    });
    await post('photo-pan', 'gestureHandlerEvent', { state: State.ACTIVE, translationX: 10, translationY: 0 });
    await post('photo-pan', 'gestureHandlerEvent', { state: State.ACTIVE, translationX: 60, translationY: 0 });
    const panned = firstPhotoZoom();
    expect(panned.x - before.x).toBe(50);

    // A second finger: the pinch takes over, holding still.
    await post('photo-pinch', 'gestureHandlerStateChange', {
      oldState: State.BEGAN, state: State.ACTIVE, scale: 1, ...centre,
    });
    await post('photo-pan', 'gestureHandlerEvent', { state: State.ACTIVE, translationX: 61, translationY: 0 });
    await post('photo-pinch', 'gestureHandlerEvent', { state: State.ACTIVE, scale: 1, ...centre });

    expect(firstPhotoZoom()).toEqual(panned);
  });

  it('frees the pager when the zoomed photo is removed', async () => {
    // 🔒 The lock was a flag only the zoomed page could clear. Remove takes
    // that page away while still zoomed, and the next photo — at 1× — could
    // not be swiped past.
    const both = [ourPhoto(1), ourPhoto(2)];
    const view = await mount(both);
    await pinch(2, async () => {});
    expect(screen.getByTestId('photo-pager').props.scrollEnabled).toBe(false);

    await view.rerender(
      <PhotoLightbox images={[ourPhoto(2)]} initialIndex={0} onClose={jest.fn()} />
    );

    expect(screen.getByTestId('photo-pager').props.scrollEnabled).toBe(true);
  });
});
