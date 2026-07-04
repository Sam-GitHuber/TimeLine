import { useState } from "react";
import Avatar from "./Avatar.jsx";

// The "what's happening" box at the top of the feed. On submit it hands the
// text up to the parent via `onPost` — in the wireframe that just prepends to
// the on-screen list. Nothing is saved anywhere yet (no backend, Phase 3).
export default function ComposeBox({ currentUser, onPost }) {
  const [text, setText] = useState("");

  function handleSubmit(event) {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    onPost(trimmed);
    setText("");
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex gap-3 border-b border-slate-200 px-4 py-4 sm:px-6"
    >
      <Avatar user={currentUser} size="md" />

      <div className="flex-1">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder="What's happening?"
          className="w-full resize-none border-0 bg-transparent text-lg text-slate-800 placeholder:text-slate-400 focus:outline-none"
        />
        <div className="mt-2 flex justify-end">
          <button
            type="submit"
            disabled={!text.trim()}
            className="rounded-full bg-sky-600 px-5 py-1.5 font-semibold text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Post
          </button>
        </div>
      </div>
    </form>
  );
}
