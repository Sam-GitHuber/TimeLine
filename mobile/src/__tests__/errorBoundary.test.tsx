/**
 * What a render error does to the app (issue #299).
 *
 * Two different kinds of test here, and both are needed:
 *
 *  - **Behaviour** — the fallback says something a family member can act on,
 *    and its two escapes do what they claim. Straightforward.
 *  - **Registration** — every screen file actually exports `ErrorBoundary`.
 *    This is the one that earns its keep. expo-router installs *no* boundary of
 *    its own (see `components/ErrorBoundary`'s header), so a screen is protected
 *    only by that one-line export, and a new screen added next month will have
 *    the crash behaviour of the app before this issue unless someone remembers.
 *    Nothing else would catch that: the app builds, the screen works, and the
 *    gap is invisible until it isn't. So it's asserted off the filesystem, the
 *    same trick `appIcons.test.ts` uses for the other thing no test looks at.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ErrorBoundary, RootErrorBoundary } from '@/components/ErrorBoundary';

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  // Read through an arrow: the factory is hoisted above `const mockReplace`, so
  // referencing it directly would capture undefined.
  router: { replace: (...args: unknown[]) => mockReplace(...args) },
}));

const APP_DIR = join(__dirname, '..', 'app');

// `__DEV__` is a global under Jest (jest-expo sets it), not a value Babel has
// already inlined — so a test can flip it and see the release-build branch.
const devGlobal = globalThis as unknown as { __DEV__: boolean };
const dev = () => devGlobal.__DEV__;
const setDev = (value: boolean) => {
  devGlobal.__DEV__ = value;
};

function screenFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return screenFiles(full);
    // Layouts get the *root* boundary instead, and only the root one does:
    // a boundary on a layout replaces that layout, tab bar and all, which is
    // the blast radius the per-screen exports exist to avoid.
    if (!entry.name.endsWith('.tsx') || entry.name === '_layout.tsx') return [];
    return [full];
  });
}

// `render` is async in RNTL v14; awaiting it is what keeps `screen` populated
// (a bare `render(...)` returns a promise that spreads to nothing, and every
// later query then throws "render has not been called").
async function renderRoute(error: Error, retry = jest.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const resetQueries = jest.spyOn(queryClient, 'resetQueries');
  const view = await render(
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary error={error} retry={retry} />
    </QueryClientProvider>
  );
  return { view, retry, resetQueries };
}

beforeEach(() => {
  mockReplace.mockReset();
});

describe('every screen registers a boundary', () => {
  it('exports ErrorBoundary from each route file', () => {
    const missing = screenFiles(APP_DIR).filter(
      (file) => !readFileSync(file, 'utf8').includes('export { ErrorBoundary }')
    );
    expect(missing).toEqual([]);
  });

  it('gives the root layout the root boundary', () => {
    const rootLayout = readFileSync(join(APP_DIR, '_layout.tsx'), 'utf8');
    expect(rootLayout).toContain('RootErrorBoundary as ErrorBoundary');
  });
});

describe('the per-screen boundary', () => {
  it('explains itself without showing a tester the error message', async () => {
    // A release build, which is what every TestFlight tester is running. The
    // raw message is a developer's, not a reader's: it means nothing to them and
    // reads as "this is really broken", which is the impression the whole
    // fallback exists to avoid.
    const wasDev = dev();
    setDev(false);
    try {
      await renderRoute(new Error('Cannot read properties of undefined'));

      expect(
        screen.getByText(/Something went wrong on this screen/i)
      ).toBeOnTheScreen();
      expect(
        screen.queryByText(/Cannot read properties of undefined/)
      ).toBeNull();
    } finally {
      setDev(wasDev);
    }
  });

  it('does show the stack in development, where it is the whole point', async () => {
    // The other half of the same decision. Catching an error means React no
    // longer reports it itself, so a boundary that swallowed it in dev too
    // would be a *downgrade* on the blank screen it replaced.
    await renderRoute(new Error('Cannot read properties of undefined'));

    expect(
      screen.getByText(/Cannot read properties of undefined/)
    ).toBeOnTheScreen();
  });

  it('clears the cache before retrying, so Try again can actually get somewhere', async () => {
    const { retry, resetQueries } = await renderRoute(new Error('boom'));

    fireEvent.press(screen.getByText('Try again'));

    // Retrying onto the same cached response — the likeliest cause of a render
    // crash — throws again immediately, which makes the button look broken.
    expect(resetQueries).toHaveBeenCalled();
    expect(retry).toHaveBeenCalled();
  });

  it('leaves by replacing, not by going back', async () => {
    const { retry } = await renderRoute(new Error('boom'));

    fireEvent.press(screen.getByText('Back to the feed'));

    // `back()` has nowhere to go on a cold-start deep link — a tapped
    // notification, which is the most common way anyone lands deep in this app
    // — and would silently do nothing, stranding the reader on the fallback.
    expect(mockReplace).toHaveBeenCalledWith('/');
    expect(retry).toHaveBeenCalled();
  });
});

describe('the root boundary', () => {
  it('offers only a retry, since nothing else is available to it', async () => {
    const retry = jest.fn();
    // Rendered with no QueryClientProvider on purpose: this is where it lives.
    // `Try` wraps the root layout, so the fallback is outside every provider
    // that layout mounts. A hook that needed one would throw inside the
    // fallback, which React answers with the blank screen we're preventing.
    await render(<RootErrorBoundary error={new Error('boom')} retry={retry} />);

    expect(screen.getByText(/TimeLine hit a problem/i)).toBeOnTheScreen();
    expect(screen.queryByText('Back to the feed')).toBeNull();

    fireEvent.press(screen.getByText('Try again'));
    expect(retry).toHaveBeenCalled();
  });
});
