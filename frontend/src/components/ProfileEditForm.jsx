import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Avatar from "./Avatar.jsx";
import AvatarCropModal from "./AvatarCropModal.jsx";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";

// Inline profile editor, rendered in place on your own profile page (issue #53).
// Edits your real name (first + last — the display name here, since there are no
// usernames), a short bio, and an avatar. Saves via dj-rest-auth's user
// endpoint, then refreshes the logged-in user so the new name/avatar show up
// everywhere (nav, compose box, feed) right away, and invalidates the cached
// profile/feed so this page and others re-render with the new details.
//
// `onDone` closes the editor (used by Cancel and after a successful save).
export default function ProfileEditForm({ onDone }) {
  const { user, refreshUser } = useAuth();
  const queryClient = useQueryClient();
  const fileInputRef = useRef(null);

  const [firstName, setFirstName] = useState(user?.first_name || "");
  const [lastName, setLastName] = useState(user?.last_name || "");
  const [bio, setBio] = useState(user?.bio || "");
  // avatarFile: the cropped file ready to upload. pendingFile: a just-chosen
  // file waiting to be reframed in the crop modal. removeAvatar: clear the
  // existing one.
  const [avatarFile, setAvatarFile] = useState(null);
  const [pendingFile, setPendingFile] = useState(null);
  const [removeAvatar, setRemoveAvatar] = useState(false);

  // Local preview for a freshly chosen avatar; revoked on change/unmount.
  const preview = useMemo(
    () => (avatarFile ? URL.createObjectURL(avatarFile) : null),
    [avatarFile]
  );
  useEffect(() => {
    if (!preview) return;
    return () => URL.revokeObjectURL(preview);
  }, [preview]);

  const mutation = useMutation({
    mutationFn: () =>
      api.updateProfile({
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        bio,
        avatar: avatarFile || undefined,
        removeAvatar: removeAvatar && !avatarFile,
      }),
    onSuccess: async () => {
      // The profile is already saved server-side at this point. Refreshing
      // "who am I" is best-effort — if that refetch blips, don't strand the
      // user in an open editor with no error (the mutation succeeded); close
      // anyway and let the invalidated queries below repaint the new details.
      try {
        await refreshUser();
      } catch {
        // ignore — the invalidations still pull the fresh profile
      }
      // Any cached copy of this profile / the feed may show a stale name or
      // avatar — drop them so they refetch with the new details.
      queryClient.invalidateQueries({ queryKey: ["user"] });
      queryClient.invalidateQueries({ queryKey: ["userPosts"] });
      queryClient.invalidateQueries({ queryKey: ["feed"] });
      onDone?.();
    },
  });

  // A chosen file goes to the crop modal first; only the reframed square it
  // returns becomes the avatar we'll upload.
  function handleAvatarChosen(event) {
    const file = event.target.files?.[0];
    if (file) setPendingFile(file);
    event.target.value = "";
  }

  function handleCropped(file) {
    setAvatarFile(file);
    setRemoveAvatar(false);
    setPendingFile(null);
  }

  function handleSubmit(event) {
    event.preventDefault();
    if (!firstName.trim() || !lastName.trim() || mutation.isPending) return;
    mutation.mutate();
  }

  // What to show in the avatar preview: a newly chosen file wins; otherwise the
  // current avatar unless we're about to remove it.
  const previewUser = preview
    ? { display_name: user?.display_name, avatar_thumb: preview }
    : removeAvatar
      ? { display_name: user?.display_name }
      : user;
  const hasAvatar = Boolean(avatarFile || (user?.avatar_thumb && !removeAvatar));

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="flex items-center gap-4">
        <Avatar user={previewUser} size="lg" />
        <div className="flex flex-wrap gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleAvatarChosen}
            className="hidden"
            data-testid="avatar-file-input"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="btn btn-ghost btn-sm"
          >
            {hasAvatar ? "Change photo" : "Add photo"}
          </button>
          {hasAvatar && (
            <button
              type="button"
              onClick={() => {
                setAvatarFile(null);
                setRemoveAvatar(true);
              }}
              className="btn btn-ghost btn-sm text-red-600"
            >
              Remove
            </button>
          )}
        </div>
      </div>

      <div className="flex gap-3">
        <label className="block flex-1">
          <span className="mb-1 block text-sm font-medium text-ink-soft">
            First name
          </span>
          <input
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            autoComplete="given-name"
            className="w-full rounded-xl border border-line-strong bg-raised px-3 py-2 text-ink transition focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-tint"
          />
        </label>
        <label className="block flex-1">
          <span className="mb-1 block text-sm font-medium text-ink-soft">
            Last name
          </span>
          <input
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            autoComplete="family-name"
            className="w-full rounded-xl border border-line-strong bg-raised px-3 py-2 text-ink transition focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-tint"
          />
        </label>
      </div>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-ink-soft">Bio</span>
        <textarea
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          rows={3}
          maxLength={500}
          placeholder="A sentence or two about you."
          className="w-full resize-none rounded-xl border border-line-strong bg-raised px-3 py-2 text-ink transition placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-tint"
        />
      </label>

      {mutation.isError && (
        <p role="alert" className="text-sm text-red-600">
          {mutation.error?.message || "Couldn't save your profile."}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => onDone?.()}
          className="btn btn-ghost btn-sm"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!firstName.trim() || !lastName.trim() || mutation.isPending}
          className="btn btn-primary btn-sm"
        >
          {mutation.isPending ? "Saving…" : "Save"}
        </button>
      </div>

      {pendingFile && (
        <AvatarCropModal
          file={pendingFile}
          onCropped={handleCropped}
          onCancel={() => setPendingFile(null)}
        />
      )}
    </form>
  );
}
