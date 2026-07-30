/**
 * Babel configuration.
 *
 * **This file changes nothing about how the app is bundled** — it makes explicit
 * what was previously implicit. With no babel config present, both Metro and
 * `jest-expo` fall back to `expo/internal/babel-preset` (the published entry for
 * `babel-preset-expo`), which is exactly what this declares. `app.json`'s
 * `experiments.reactCompiler` is still read by the preset itself, so the React
 * Compiler stays on.
 *
 * It exists because of Phase 10. Running the Jest suite per-platform
 * (`jest-expo/ios` + `jest-expo/android`, see `jest.config.js`) is what
 * exercises the app's `Platform.OS === 'android'` branches — but those platform
 * presets hand `babel-jest` only a `caller`, dropping the `presets` that the
 * root `jest-expo` preset injects for you. Without a babel config on disk to
 * fall back on, nothing supplies a preset at all and **every** suite dies
 * parsing the first Flow-typed file in React Native's own test setup:
 *
 *     SyntaxError: node_modules/@react-native/jest-preset/jest/setup.js:
 *     Unexpected token, expected "," — value(id: TimeoutID): void
 *
 * That error names React Native, so it reads like a broken dependency rather
 * than a missing config file, which is the only reason it's worth this comment.
 */

module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
  };
};
