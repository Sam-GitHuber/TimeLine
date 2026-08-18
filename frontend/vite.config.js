import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Listen on all interfaces so the dev server is reachable from outside
    // the Docker container (i.e. from your browser on the host).
    host: true,
    port: 5173,
  },
  test: {
    // Run tests in a simulated browser (jsdom) so React components can render.
    globals: true,
    environment: "jsdom",
    setupFiles: "./test/setup.js",
    // Unwind `afterEach` in reverse registration order, so the console guard —
    // registered first, from the setup file — runs *after* RTL's automatic
    // `cleanup`. An error thrown while unmounting then belongs to the test that
    // mounted it. This is Vitest's default, but the guard's correctness rests on
    // it, so it's declared rather than inherited (the CLI's own help still
    // advertises the old "parallel" default).
    sequence: { hooks: "stack" },
  },
});
