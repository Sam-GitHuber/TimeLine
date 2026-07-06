// Extends Vitest's `expect` with DOM matchers like `toBeInTheDocument()`.
// Loaded automatically before every test (see `setupFiles` in vite.config.js).
import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement object URLs, which our image-preview effects use
// (ComposeBox, ProfileEditPage). Stub them so those components render in tests.
if (!URL.createObjectURL) {
  URL.createObjectURL = () => "blob:mock";
  URL.revokeObjectURL = () => {};
}
