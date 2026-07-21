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

import { PostCard } from '@/components/PostCard';
import type { Post, PostImage } from '@/types';

// The card navigates on tap; there's no router in a unit test, and where it
// navigates to is `postDetail`'s subject, not this file's.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
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
});
