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
};
