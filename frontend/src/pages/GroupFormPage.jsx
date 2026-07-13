import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Avatar from "../components/Avatar.jsx";
import AvatarCropModal from "../components/AvatarCropModal.jsx";
import { api } from "../api.js";

// Create a new group, or edit an existing one (same form). In edit mode we
// prefill from the group and only admins can reach a useful result — the backend
// enforces that; a non-admin's PATCH 403s and we surface the error.
//
// The avatar handling mirrors ProfileEditPage: a chosen file previews locally,
// and in edit mode you can also remove an existing avatar.
export default function GroupFormPage() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const groupId = id ? Number(id) : null;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fileInputRef = useRef(null);

  const existing = useQuery({
    queryKey: ["group", groupId],
    queryFn: () => api.getGroup(groupId),
    enabled: isEdit,
  });

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [avatarFile, setAvatarFile] = useState(null);
  const [pendingFile, setPendingFile] = useState(null);
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [loadedFor, setLoadedFor] = useState(null);

  // Prefill once the group loads (edit mode). Adjusting state *during render*
  // when a prop changes is React's documented alternative to an effect here — it
  // re-renders immediately without an intermediate paint, and the `loadedFor`
  // guard means we only seed the fields once (never clobbering later edits).
  const group = existing.data;
  if (group && loadedFor !== group.id) {
    setName(group.name);
    setDescription(group.description || "");
    setLoadedFor(group.id);
  }

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
      isEdit
        ? api.updateGroup(groupId, {
            name: name.trim(),
            description,
            avatar: avatarFile || undefined,
            removeAvatar: removeAvatar && !avatarFile,
          })
        : api.createGroup({
            name: name.trim(),
            description,
            avatar: avatarFile || undefined,
          }),
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ["groups"] });
      queryClient.invalidateQueries({ queryKey: ["group", saved.id] });
      navigate(`/g/${saved.id}`);
    },
  });

  // A chosen file is reframed in the crop modal first (mirrors ProfileEditPage);
  // the returned square becomes the avatar we'll upload.
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
    if (!name.trim() || mutation.isPending) return;
    mutation.mutate();
  }

  if (isEdit && existing.isError) {
    return (
      <p className="px-6 py-10 text-center text-red-600">
        {existing.error?.status === 404
          ? "This group doesn't exist, or you're not in it."
          : existing.error?.message || "Couldn't load the group."}
      </p>
    );
  }

  const previewGroup = preview
    ? { display_name: name || "?", avatar_thumb: preview }
    : removeAvatar
      ? { display_name: name || "?" }
      : {
          display_name: name || "?",
          avatar_thumb: group?.avatar_thumb,
        };
  const hasAvatar = Boolean(
    avatarFile || (group?.avatar_thumb && !removeAvatar)
  );

  return (
    <div className="px-5 py-7">
      <h1 className="mb-6 font-display text-2xl font-bold -tracking-[0.02em] text-ink">
        {isEdit ? "Edit group" : "New group"}
      </h1>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="flex items-center gap-4">
          <Avatar user={previewGroup} size="lg" />
          <div className="flex flex-wrap gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleAvatarChosen}
              className="hidden"
              data-testid="group-avatar-input"
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

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-soft">
            Name
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            placeholder="Family, book club, five-a-side…"
            className="w-full rounded-xl border border-line-strong bg-raised px-3 py-2 text-ink transition focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-tint"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-soft">
            Description
          </span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="What's this group for?"
            className="w-full resize-none rounded-xl border border-line-strong bg-raised px-3 py-2 text-ink transition placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-tint"
          />
        </label>

        {mutation.isError && (
          <p role="alert" className="text-sm text-red-600">
            {mutation.error?.message || "Couldn't save the group."}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => navigate(isEdit ? `/g/${groupId}` : "/groups")}
            className="btn btn-ghost btn-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim() || mutation.isPending}
            className="btn btn-primary btn-sm"
          >
            {mutation.isPending
              ? "Saving…"
              : isEdit
                ? "Save"
                : "Create group"}
          </button>
        </div>
      </form>

      {pendingFile && (
        <AvatarCropModal
          file={pendingFile}
          onCropped={handleCropped}
          onCancel={() => setPendingFile(null)}
        />
      )}
    </div>
  );
}
