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
import { fireEvent, render, screen } from '@testing-library/react-native';

import { PhotoLightbox } from '@/components/PhotoLightbox';
import { PostCard } from '@/components/PostCard';
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
