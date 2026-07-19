/**
 * Jest + React Native Testing Library — unit and component tests only.
 *
 * Mirrors the web app's Vitest + RTL setup so the mental model carries over.
 * There is deliberately **no Detox/Maestro E2E suite**: it would mean a second
 * tool, simulator infrastructure in CI, and a well-known flakiness tax that
 * isn't worth it at this scale (docs/phases/phase-9-iphone-app.md).
 */

module.exports = {
  // jest-expo's preset knows how to transform Expo's and React Native's ESM
  // packages, which a stock Jest config chokes on.
  preset: 'jest-expo',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
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
