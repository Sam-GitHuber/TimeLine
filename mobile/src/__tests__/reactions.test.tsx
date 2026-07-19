/**
 * Reacting, from the feed or a comment.
 *
 * The toggle semantics are the thing worth pinning: the endpoint *toggles*, so
 * sending an emoji you've already used removes it, and the response — not a
 * guess made on the client — is what the row then shows.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert, Text } from 'react-native';

import { ReactionBar } from '@/components/ReactionBar';
import { trayPosition } from '@/components/ReactionTray';
import type { Reaction } from '@/types';

/**
 * The emoji grid is the library's own UI, so it's stubbed and its props are
 * captured — what we own is *what we do with the emoji it hands back*, not the
 * grid itself. (Rendering the real one would also pull its whole emoji dataset
 * into every test in this file.)
 */
let emojiPickerProps: { onEmojiSelected: (e: { emoji: string }) => void };
jest.mock('rn-emoji-keyboard', () => ({
  __esModule: true,
  default: (props: { onEmojiSelected: (e: { emoji: string }) => void }) => {
    emojiPickerProps = props;
    return null;
  },
}));

const mockFetch = jest.fn();

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === null ? '' : JSON.stringify(body)),
    json: async () => body,
  };
}

function renderBar(reactions: Reaction[], target: { postId?: number; commentId?: number } = { postId: 5 }) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ReactionBar {...target} reactions={reactions} />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  mockFetch.mockReset();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

it('renders the pruned counts exactly as the server sent them', async () => {
  // Two viewers legitimately see different counts on the same post; the client
  // never recomputes them.
  await renderBar([
    { emoji: '👍', count: 3, reacted: true },
    { emoji: '🎉', count: 1, reacted: false },
  ]);

  expect(screen.getByText('3')).toBeTruthy();
  expect(screen.getByText('1')).toBeTruthy();
});

it('toggles a chip and shows what came back, not a guess', async () => {
  // The server returns the freshly aggregated summary; if the client guessed
  // instead, its count would drift from everyone else's.
  mockFetch.mockResolvedValue(
    jsonResponse({ reactions: [{ emoji: '👍', count: 2, reacted: false }] })
  );

  await renderBar([{ emoji: '👍', count: 3, reacted: true }]);

  await fireEvent.press(screen.getByText('👍'));

  expect(await screen.findByText('2')).toBeTruthy();
  const [url, init] = mockFetch.mock.calls[0];
  expect(url).toContain('/api/posts/5/react/');
  expect(JSON.parse(init.body)).toEqual({ emoji: '👍' });
});

it('reacts to a comment on the comment endpoint', async () => {
  mockFetch.mockResolvedValue(
    jsonResponse({ reactions: [{ emoji: '❤️', count: 1, reacted: true }] })
  );

  await renderBar([], { commentId: 12 });

  await fireEvent.press(screen.getByLabelText('Add a reaction'));
  await fireEvent.press(await screen.findByLabelText('React with ❤️'));

  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  expect(mockFetch.mock.calls[0][0]).toContain('/api/comments/12/react/');
});

it('opens the tray in place, without needing a measurement first', async () => {
  // The tray must not be gated on `measureInWindow` calling back: if it were,
  // a failed measurement would leave a button that silently does nothing.
  await renderBar([]);

  expect(screen.queryByLabelText('React with 👍')).toBeNull();

  await fireEvent.press(screen.getByLabelText('Add a reaction'));

  expect(await screen.findByLabelText('React with 👍')).toBeTruthy();
  expect(screen.getByLabelText('More emoji')).toBeTruthy();
});

it('closes the tray when you tap away', async () => {
  await renderBar([]);

  await fireEvent.press(screen.getByLabelText('Add a reaction'));
  await screen.findByLabelText('React with 👍');

  await fireEvent.press(screen.getByLabelText('Close reactions'));

  expect(screen.queryByLabelText('React with 👍')).toBeNull();
  expect(mockFetch).not.toHaveBeenCalled();
});

it('marks an emoji you have already used as active in the tray', async () => {
  // So a second tap reads as "remove this", matching what the endpoint does.
  await renderBar([{ emoji: '👍', count: 2, reacted: true }]);

  await fireEvent.press(screen.getByLabelText('Add a reaction'));

  expect(await screen.findByLabelText('Remove 👍 reaction')).toBeTruthy();
});

it('sends whatever the full grid returns, so any emoji stays reachable', async () => {
  mockFetch.mockResolvedValue(
    jsonResponse({ reactions: [{ emoji: '🦔', count: 1, reacted: true }] })
  );

  await renderBar([]);

  await fireEvent.press(screen.getByLabelText('Add a reaction'));
  await fireEvent.press(screen.getByLabelText('More emoji'));
  // Stand in for a tap inside the emoji grid, which is the library's UI.
  await act(async () => {
    emojiPickerProps.onEmojiSelected({ emoji: '🦔' });
  });

  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ emoji: '🦔' });
});

it('tells you when the server rejects a reaction', async () => {
  // The per-target cap and emoji validation both live server-side, so a
  // rejection has to reach the person rather than leaving a tap looking done.
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  mockFetch.mockResolvedValue(
    jsonResponse({ emoji: ['You’ve reacted to this as many times as allowed (20).'] }, 400)
  );

  await renderBar([]);

  await fireEvent.press(screen.getByLabelText('Add a reaction'));
  await fireEvent.press(await screen.findByLabelText('React with 👍'));

  await waitFor(() =>
    expect(alert).toHaveBeenCalledWith(
      'Couldn’t react',
      'You’ve reacted to this as many times as allowed (20).'
    )
  );
  alert.mockRestore();
});

it('offers "who reacted" only once there is someone to show', async () => {
  const { rerender } = await renderBar([]);
  expect(screen.queryByText('Who reacted?')).toBeNull();

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  await rerender(
    <QueryClientProvider client={queryClient}>
      <ReactionBar postId={5} reactions={[{ emoji: '👍', count: 1, reacted: false }]} />
    </QueryClientProvider>
  );

  expect(screen.getByText('Who reacted?')).toBeTruthy();
});

it('re-syncs when the server summary changes underneath it', async () => {
  // A feed refetch brings new counts; the row must follow them rather than
  // clinging to what it rendered first.
  const { rerender } = await renderBar([{ emoji: '👍', count: 1, reacted: false }]);
  expect(screen.getByText('1')).toBeTruthy();

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  await rerender(
    <QueryClientProvider client={queryClient}>
      <ReactionBar postId={5} reactions={[{ emoji: '👍', count: 4, reacted: false }]} />
    </QueryClientProvider>
  );

  expect(screen.getByText('4')).toBeTruthy();
});

describe('trayPosition', () => {
  const screen390 = { width: 390, height: 844 };
  // Must match ReactionTray's own geometry.
  const TRAY_WIDTH = 44 * 5 + 8 * 2;
  const TRAY_HEIGHT = 44 + 8 * 2;

  it('centres the tray on its trigger', () => {
    const { left } = trayPosition(
      { x: 180, y: 400, width: 26, height: 26 },
      screen390
    );
    expect(left).toBeCloseTo(180 + 13 - TRAY_WIDTH / 2);
  });

  it('sits above the trigger, leaving the post visible', () => {
    const { top } = trayPosition(
      { x: 180, y: 400, width: 26, height: 26 },
      screen390
    );
    expect(top).toBe(400 - TRAY_HEIGHT - 8);
  });

  it('flips below when there is no room above', () => {
    // A reaction row near the top of the screen.
    const anchor = { x: 180, y: 10, width: 26, height: 26 };
    const { top } = trayPosition(anchor, screen390);
    expect(top).toBe(10 + 26 + 8);
  });

  it('never runs off either edge', () => {
    const hardLeft = trayPosition({ x: 0, y: 400, width: 26, height: 26 }, screen390);
    expect(hardLeft.left).toBeGreaterThanOrEqual(8);

    const hardRight = trayPosition(
      { x: 384, y: 400, width: 26, height: 26 },
      screen390
    );
    expect(hardRight.left + TRAY_WIDTH).toBeLessThanOrEqual(390 - 8);
  });

  it('still lands somewhere sensible with no measurement', () => {
    // The degraded path: better a centred tray than none at all.
    const { left, top } = trayPosition(null, screen390);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + TRAY_WIDTH).toBeLessThanOrEqual(390);
    expect(top).toBeGreaterThan(0);
  });
});

describe('the trailing slot', () => {
  // Where the post's "N comments" link belongs depends on whether the row
  // already has chips in it, and only this component knows that live.
  function renderWithTrailing(reactions: Reaction[]) {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { gcTime: 0 },
      },
    });
    return render(
      <QueryClientProvider client={queryClient}>
        <ReactionBar
          postId={5}
          reactions={reactions}
          trailing={<Text>12 comments</Text>}
        />
      </QueryClientProvider>
    );
  }

  it('folds it onto the reaction row when there is nothing to react with', async () => {
    // A lone `+` with an orphaned link beneath it burns two near-empty lines.
    const view = await renderWithTrailing([]);

    const link = screen.getByText('12 comments');
    const addButton = screen.getByLabelText('Add a reaction');
    expect(sharesRowWith(view, link, addButton)).toBe(true);
  });

  it('drops it to its own line once there are chips to share with', async () => {
    // The row is busy by then, and sharing crowds both.
    const view = await renderWithTrailing([{ emoji: '👍', count: 3, reacted: true }]);

    const link = screen.getByText('12 comments');
    const addButton = screen.getByLabelText('Add a reaction');
    expect(sharesRowWith(view, link, addButton)).toBe(false);
  });

  it('moves it down the moment you add the first reaction', async () => {
    // The whole reason placement lives in this component: the caller only has
    // the server's list, which is still empty at this point.
    mockFetch.mockResolvedValue(
      jsonResponse({ reactions: [{ emoji: '👍', count: 1, reacted: true }] })
    );
    const view = await renderWithTrailing([]);

    const addButton = screen.getByLabelText('Add a reaction');
    expect(sharesRowWith(view, screen.getByText('12 comments'), addButton)).toBe(true);

    await fireEvent.press(addButton);
    await fireEvent.press(await screen.findByLabelText('React with 👍'));
    await screen.findByText('1');

    expect(
      sharesRowWith(
        view,
        screen.getByText('12 comments'),
        screen.getByLabelText('Add a reaction')
      )
    ).toBe(false);
  });
});

/** Whether `a` and `b` share a nearest common ancestor that is the flex row. */
function sharesRowWith(
  _view: unknown,
  a: { parent: unknown },
  b: { parent: unknown }
): boolean {
  const ancestors = new Set();
  for (let node = a as { parent: unknown } | null; node; node = node.parent as never) {
    ancestors.add(node);
  }
  for (let node = b as { parent: unknown } | null; node; node = node.parent as never) {
    if (ancestors.has(node)) {
      // The nearest shared ancestor is the reaction row itself when they are
      // siblings in it, and the outer fragment's wrapper when they are not.
      const style = (node as { props?: { style?: { flexDirection?: string } } })
        .props?.style;
      return style?.flexDirection === 'row';
    }
  }
  return false;
}
