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
    <form onSubmit={handleSubmit} className="tl-compose">
      <div className="tl-rail">
        <span className="tl-node" aria-hidden="true" />
        <span className="tl-now font-mono text-xs font-medium text-accent-deep">
          now
        </span>
      </div>

      <div className="flex flex-1 gap-3 pl-5">
        <Avatar user={user} size="md" />

        <div className="flex-1">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            placeholder="What's happening?"
            className="w-full resize-none rounded-2xl border border-line-strong bg-raised px-4 py-3 text-base text-ink transition placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-tint"
          />
          {mutation.isError && (
            <p className="mt-1 text-sm text-red-600">
              {mutation.error?.message || "Couldn't post. Try again."}
            </p>
          )}
          <div className="mt-2 flex justify-end">
            <button
              type="submit"
              disabled={!text.trim() || mutation.isPending}
              className="btn btn-primary btn-sm"
            >
              {mutation.isPending ? "Posting…" : "Post"}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
