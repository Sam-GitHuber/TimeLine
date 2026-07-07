import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Avatar from "./Avatar.jsx";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";

// Kept in step with the backend cap (api.imaging.MAX_IMAGES_PER_POST) so we
// stop the user before a doomed request rather than after a 400.
const MAX_IMAGES = 10;

// The "what's happening" box at the top of a timeline. On submit it creates a
// real post — text, photos, or both — via the API, then invalidates the right
// list so the new post appears. Pass a `group` id to post into that group's
// timeline (and refresh it) instead of your personal feed.
export default function ComposeBox({ group = null }) {
  const { user } = useAuth();
  const [text, setText] = useState("");
  const [images, setImages] = useState([]);
  const fileInputRef = useRef(null);
  const queryClient = useQueryClient();

  // Object URLs for local previews. Derived from the chosen files during render,
  // then revoked when they change / on unmount so we don't leak blob URLs.
  const previews = useMemo(
    () => images.map((file) => URL.createObjectURL(file)),
    [images]
  );
  useEffect(
    () => () => previews.forEach((url) => URL.revokeObjectURL(url)),
    [previews]
  );

  const mutation = useMutation({
    mutationFn: ({ text: value, images: files }) =>
      api.createPost(value, files, group),
    onSuccess: () => {
      setText("");
      setImages([]);
      // The home feed always refreshes — a group post can surface there via the
      // "include groups" toggle. Then refresh the specific list it landed in:
      // the group's timeline, or (for a personal post) your own profile.
      queryClient.invalidateQueries({ queryKey: ["feed"] });
      if (group) {
        queryClient.invalidateQueries({ queryKey: ["groupPosts", group] });
      } else {
        queryClient.invalidateQueries({ queryKey: ["userPosts", user?.pk] });
      }
    },
  });

  function handleFilesChosen(event) {
    const chosen = Array.from(event.target.files || []);
    // Append, but never exceed the cap. Reset the input so picking the same
    // file again still fires a change event.
    setImages((current) => [...current, ...chosen].slice(0, MAX_IMAGES));
    event.target.value = "";
  }

  function removeImage(index) {
    setImages((current) => current.filter((_, i) => i !== index));
  }

  const canPost = (text.trim() || images.length > 0) && !mutation.isPending;

  function handleSubmit(event) {
    event.preventDefault();
    if (!canPost) return;
    mutation.mutate({ text: text.trim(), images });
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
            placeholder={group ? "Share with the group…" : "What's happening?"}
            className="w-full resize-none rounded-2xl border border-line-strong bg-raised px-4 py-3 text-base text-ink transition placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-tint"
          />

          {previews.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-2">
              {previews.map((url, index) => (
                <li key={url} className="relative">
                  <img
                    src={url}
                    alt={`Selected photo ${index + 1}`}
                    className="h-20 w-20 rounded-xl object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removeImage(index)}
                    aria-label={`Remove photo ${index + 1}`}
                    className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-ink text-xs font-bold text-white shadow"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}

          {mutation.isError && (
            <p className="mt-1 text-sm text-red-600">
              {mutation.error?.message || "Couldn't post. Try again."}
            </p>
          )}

          <div className="mt-2 flex items-center justify-between">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handleFilesChosen}
              className="hidden"
              data-testid="compose-file-input"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={images.length >= MAX_IMAGES}
              className="btn btn-ghost btn-sm"
            >
              {images.length > 0
                ? `Photos (${images.length}/${MAX_IMAGES})`
                : "Add photos"}
            </button>
            <button
              type="submit"
              disabled={!canPost}
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
