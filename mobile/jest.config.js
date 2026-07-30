/**
 * Jest + React Native Testing Library — unit and component tests only.
 *
 * Mirrors the web app's Vitest + RTL setup so the mental model carries over.
 * There is deliberately **no Detox/Maestro E2E suite**: it would mean a second
 * tool, simulator infrastructure in CI, and a well-known flakiness tax that
 * isn't worth it at this scale (docs/reference/mobile-app.md).
 *
 * **The suite runs twice, once per platform** (Phase 10). `jest-expo` ships a
 * preset per platform, and the platform decides what `Platform.OS` reports and
 * which `.ios.tsx` / `.android.tsx` file a bare import resolves to. Under the
 * single `jest-expo` preset the whole suite ran as iOS, so every
 * `Platform.OS === 'android'` branch in the app — the action-sheet fallbacks,
 * the keyboard-avoidance behaviour, the date pickers — was **dead code as far as
 * CI was concerned**, and would first be exercised by a person holding a phone.
 * Running both projects is what makes an Android regression a red test rather
 * than a bug report.
 *
 * `projects` means Jest treats each entry as its own run with its own config,
 * so anything the suites need has to be *inside* `shared` — a top-level option
 * next to `projects` is silently ignored. `displayName` is what tags each
 * failure `[ios]` or `[android]` in the output; without it a failure in one
 * platform is indistinguishable from the same test failing in the other.
 */

/**
 * Everything both projects need. Spread into each, never set at the top level.
 */
const shared = {
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
};

module.exports = {
  projects: [
    { ...shared, preset: 'jest-expo/ios', displayName: 'ios' },
    { ...shared, preset: 'jest-expo/android', displayName: 'android' },
  ],

  // Coverage is collected across both runs, so it stays at the top level.
  collectCoverageFrom: ['src/**/*.{ts,tsx}'],

  /**
   * Jest's default is 5s, which is not enough headroom on a shared CI runner.
   *
   * The **first test in a suite that mounts a component** pays for loading and
   * transforming React Native and the Expo preset — locally that's under a
   * second, but on GitHub's runners the same suites take five to ten times
   * longer, and it is always that first mount that goes over. Every later test
   * in the file then passes comfortably, which is the tell: this is warmup cost,
   * not a slow or hanging test.
   *
   * So this is headroom, not a mask for flakiness. A test that genuinely hangs
   * still fails here, just 20s later. Raising it beats the alternatives —
   * sprinkling per-test timeouts on whichever test happens to be first, or
   * trimming real coverage to stay under an arbitrary limit.
   */
  testTimeout: 20000,
};
