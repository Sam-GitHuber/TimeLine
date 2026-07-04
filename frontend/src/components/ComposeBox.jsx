import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Avatar from "./Avatar.jsx";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";

// The "what's happening" box at the top of the feed. On submit it creates a
// real post via the API, then invalidates the feed so the new post appears.
export default function ComposeBox() {
  const { user } = useAuth();
  const [text, setText] = useState("");
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (value) => api.createPost(value),
    onSuccess: () => {
      setText("");
      queryClient.invalidateQueries({ queryKey: ["feed"] });
      // If you're looking at your own profile, refresh that too.
      queryClient.invalidateQueries({ queryKey: ["userPosts", user?.pk] });
    },
  });

  function handleSubmit(event) {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    mutation.mutate(trimmed);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex gap-3 border-b border-slate-200 px-4 py-4 sm:px-6"
    >
      <Avatar user={user} size="md" />

      <div className="flex-1">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder="What's happening?"
          className="w-full resize-none border-0 bg-transparent text-lg text-slate-800 placeholder:text-slate-400 focus:outline-none"
        />
        {mutation.isError && (
          <p className="text-sm text-rose-600">
            {mutation.error?.message || "Couldn't post. Try again."}
          </p>
        )}
        <div className="mt-2 flex justify-end">
          <button
            type="submit"
            disabled={!text.trim() || mutation.isPending}
            className="rounded-full bg-sky-600 px-5 py-1.5 font-semibold text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {mutation.isPending ? "Posting…" : "Post"}
          </button>
        </div>
      </div>
    </form>
  );
}
