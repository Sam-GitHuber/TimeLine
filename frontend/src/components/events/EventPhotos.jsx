import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../api.js";
import { serverMessage } from "../../errors.js";
import { useInfiniteList } from "../../hooks.js";
import Lightbox from "../Lightbox.jsx";
import LoadMoreButton from "../LoadMoreButton.jsx";
import PhotoGrid from "../PhotoGrid.jsx";
import ConfirmDeleteDialog from "../ConfirmDeleteDialog.jsx";

// The event's photo album, on the event page. **Anyone who can see the event
// can add to it**, before, during or after — the one place in this feature that
// isn't the organiser's, because the photos from a day out belong to whoever
// took them.
//
// What you see is pruned to the uploaders you may see (the organiser plus your
// connections), exactly like the event's comments and unlike the poll and RSVP
// tallies above it. That's server-side, so this component just renders what
// arrives — but it's why the count here can differ from what someone standing
// next to you sees, and why the empty state doesn't claim the album is empty.
export default function EventPhotos({ eventId, onChange }) {
  const inputRef = useRef(null);
  const [lightboxIndex, setLightboxIndex] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  // A refused write is otherwise completely silent here: the grid simply
  // doesn't grow, which reads as "the upload is still going". See
  // connections.md — the server's words when it wrote any, our own per-action
  // fallback when it didn't (offline is exactly that case).
  const [error, setError] = useState(null);

  const photosQuery = useInfiniteList(["eventPhotos", eventId], () =>
    api.getEventPhotos(eventId)
  );
  const photos = photosQuery.items;

  const add = useMutation({
    mutationFn: (files) => api.addEventPhotos(eventId, files),
    onSuccess: () => {
      setError(null);
      onChange();
    },
    onError: (err) =>
      setError(serverMessage(err, "Couldn't add those photos.")),
  });

  // The delete's own rejection is rendered by the confirm dialog rather than
  // by this section, following the rule the event page's other writes settled
  // on (#237): the message goes beside the control that was pressed, and the
  // dialog is what holds that control.
  const remove = useMutation({
    mutationFn: (photoId) => api.deleteEventPhoto(photoId),
    onSuccess: () => {
      setPendingDelete(null);
      setLightboxIndex(null);
      onChange();
    },
  });

  const onPick = (event) => {
    const files = Array.from(event.target.files || []);
    // Reset the input first: picking the same files again after a failure is a
    // realistic retry, and a file input fires no change event for an unchanged
    // value.
    event.target.value = "";
    if (files.length) add.mutate(files);
  };

  const current = lightboxIndex === null ? null : photos[lightboxIndex];

  return (
    <section className="mt-6 border-t border-line pt-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-base font-semibold text-ink">
          Photos
          {photos.length > 0 && (
            <span className="ml-2 font-mono text-sm font-normal tabular-nums text-ink-faint">
              {photosQuery.data?.pages?.[0]?.count ?? photos.length}
            </span>
          )}
        </h2>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={add.isPending}
          className="btn btn-ghost btn-sm"
        >
          {add.isPending ? "Adding…" : "Add photos"}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={onPick}
          className="hidden"
          aria-label="Add photos to this event"
        />
      </div>

      {error && (
        <p role="alert" className="mb-3 text-sm text-red-600">
          {error}
        </p>
      )}

      {photosQuery.isLoading ? (
        <p className="text-sm text-ink-faint">Loading photos…</p>
      ) : photos.length === 0 ? (
        // Carefully not "there are no photos": you're seeing your slice of the
        // album, so someone you aren't connected to may well have added some.
        <p className="text-sm text-ink-faint">
          No photos here yet — add the first.
        </p>
      ) : (
        <>
          <PhotoGrid images={photos} onOpen={setLightboxIndex} />
          <LoadMoreButton query={photosQuery} />
        </>
      )}

      {photosQuery.isError && (
        // A list that stopped short is indistinguishable from one that ended,
        // and here that silently under-states the album. Rendered above the
        // rows' fold rather than as an empty state, because the case this
        // exists for is the album that *did* load a page.
        <p className="mt-2 text-sm text-red-600">
          Couldn&rsquo;t load all the photos.
        </p>
      )}

      {current && (
        <Lightbox
          images={photos}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onIndexChange={setLightboxIndex}
          caption={current.uploader?.display_name}
          onDelete={
            current.can_delete ? () => setPendingDelete(current) : undefined
          }
        />
      )}

      {pendingDelete && (
        <ConfirmDeleteDialog
          label="Remove photo"
          title="Remove this photo?"
          description="It comes off the event for everyone who can see it. This can't be undone."
          errorFallback="Couldn’t remove that photo."
          pending={remove.isPending}
          error={remove.error}
          onCancel={() => {
            remove.reset();
            setPendingDelete(null);
          }}
          onConfirm={() => remove.mutate(pendingDelete.id)}
        />
      )}
    </section>
  );
}
