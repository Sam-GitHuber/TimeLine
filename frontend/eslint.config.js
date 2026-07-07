// ESLint flat config (ESLint 9). Catches real bugs — unused variables,
// missing React Hook dependencies, accidental globals — rather than style
// nits, which we leave to formatting. Runs in CI via `npm run lint`.
import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default [
  // Don't lint build output or dependencies.
  { ignores: ["dist/**", "node_modules/**"] },

  // App source: browser environment, modern JSX.
  {
    files: ["src/**/*.{js,jsx}"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.browser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      react,
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    settings: { react: { version: "detect" } },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // We're on the modern JSX transform (Vite) — no need to import React
      // into scope for JSX.
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      // Literal apostrophes/quotes in JSX text render fine; escaping them to
      // &apos; etc. hurts readability more than it helps.
      "react/no-unescaped-entities": "off",
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },

  // Tests + config run under Node/Vitest, so allow those globals.
  {
    files: ["test/**/*.{js,jsx}", "**/*.test.{js,jsx}", "*.config.js"],
    languageOptions: {
      globals: { ...globals.node, ...globals.vitest },
    },
  },
];
