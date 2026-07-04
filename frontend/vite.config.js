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
  },
});
