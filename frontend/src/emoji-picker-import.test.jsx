import { describe, it, expect } from "vitest";

// Guards the emoji picker's self-hosted data wiring — deliberately *unmocked*,
// unlike reactions.test.jsx which stubs the picker. Without this, a broken or
// unresolvable emoji-data import (e.g. the package missing from the running
// container's node_modules) sails past the whole suite and only blows up at
// runtime in the browser. See docs/phases/phase-7b-emoji-reactions.md.
describe("emoji picker data wiring", () => {
  it("resolves the bundled emoji data as a first-party (non-CDN) URL", async () => {
    const mod = await import(
      "emoji-picker-element-data/en/emojibase/data.json?url"
    );
    expect(typeof mod.default).toBe("string");
    // Must be served from our own origin — never a third-party CDN (the app's
    // no-external-requests privacy stance). Vite gives a local path here.
    expect(mod.default).not.toMatch(/^https?:\/\//);
  });

  it("loads the real EmojiPickerPopover module (its data import resolves)", async () => {
    const mod = await import("./components/EmojiPickerPopover.jsx");
    expect(typeof mod.default).toBe("function");
  });
});
