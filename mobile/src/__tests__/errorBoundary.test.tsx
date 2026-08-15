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
// Restored in `afterEach` rather than a try/finally, so a failing assertion
// can't leak `false` into the test that asserts the dev branch.
const devGlobal = globalThis as unknown as { __DEV__: boolean };

// Every extension expo-router treats as a route. The scan below used to collect
// only `.tsx`, which made it a leaky net for the one thing it exists to catch:
// expo-router's route context matches `/.*\.[tj]sx?$/`, so a screen added as
// `.ts`, `.js` or `.jsx` is a real route that would have passed the check with
// no boundary at all.
const ROUTE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'];

/**
 * Every route file that must carry the per-screen boundary.
 *
 * Only the *root* layout is exempt, because it gets `RootErrorBoundary`
 * instead. `(tabs)/_layout.tsx` is deliberately **not** exempt: it runs three
 * badge queries of its own, and a throw there would otherwise skip every
 * per-screen boundary and take the whole app down through the root one.
 */
function routeFiles(dir: string, atRoot = true): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(full, false);
    if (!ROUTE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) return [];
    if (atRoot && entry.name === '_layout.tsx') return [];
    return [full];
  });
}

// `render` is async in RNTL v14; awaiting it is what keeps `screen` populated
// (a bare `render(...)` returns a promise that spreads to nothing, and every
// later query then throws "render has not been called").
async function renderRoute(error: Error) {
  const retry = jest.fn();
  const queryClient = new QueryClient({
    // `gcTime: 0` on **mutations** as well as queries — they have separate
    // caches with separate five-minute timers, and a suite that leaves either
    // running hangs the Jest run rather than failing it (mobile-app.md).
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });
  const resetQueries = jest.spyOn(queryClient, 'resetQueries');
  await render(
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary error={error} retry={retry} />
    </QueryClientProvider>
  );
  return { retry, resetQueries };
}

let consoleError: jest.SpyInstance;

beforeEach(() => {
  mockReplace.mockReset();
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
  devGlobal.__DEV__ = true;
});

describe('every screen registers a boundary', () => {
  it('exports ErrorBoundary from each route file', () => {
    const missing = routeFiles(APP_DIR).filter(
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
    devGlobal.__DEV__ = false;
    await renderRoute(new Error('Cannot read properties of undefined'));

    expect(
      screen.getByText(/Something went wrong on this screen/i)
    ).toBeOnTheScreen();
    expect(screen.queryByText(/Cannot read properties of undefined/)).toBeNull();
    // ...but it is still *reported*, which is the whole point of logging from
    // the fallback: expo-router's `Try` has no `componentDidCatch`, so without
    // this a release-build crash would leave no trace anywhere at all.
    expect(consoleError).toHaveBeenCalledWith(
      '[crash] render error caught by ErrorBoundary:',
      expect.any(Error)
    );
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
    // Scoped to `inactive`: the crashed screen has unmounted, so its queries are
    // the inactive ones, while everything still on screen (the tab badges, the
    // stack underneath) keeps its data instead of blinking to a spinner.
    expect(resetQueries).toHaveBeenCalledWith({ type: 'inactive' });
    expect(retry).toHaveBeenCalled();
  });

  it('leaves by replacing, not by going back — and resets on the way out', async () => {
    const { retry, resetQueries } = await renderRoute(new Error('boom'));

    fireEvent.press(screen.getByText('Back to the feed'));

    // `back()` has nowhere to go on a cold-start deep link — a tapped
    // notification, which is the most common way anyone lands deep in this app
    // — and would silently do nothing, stranding the reader on the fallback.
    expect(mockReplace).toHaveBeenCalledWith('/');
    // The reset is what stops this being a no-op on the feed tab itself, where
    // `replace('/')` navigates nowhere and `retry()` alone would re-render the
    // same screen against the same poisoned cache.
    expect(resetQueries).toHaveBeenCalledWith({ type: 'inactive' });
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
    // It still reports, even with no provider to lean on.
    expect(consoleError).toHaveBeenCalledWith(
      '[crash] render error caught by ErrorBoundary:',
      expect.any(Error)
    );

    fireEvent.press(screen.getByText('Try again'));
    expect(retry).toHaveBeenCalled();
  });
});
