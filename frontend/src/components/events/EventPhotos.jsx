import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../api.js";
import { serverMessage } from "../../errors.js";
import { useFetchAllPages, useInfiniteList } from "../../hooks.js";
import Lightbox from "../Lightbox.jsx";
import LoadMoreButton from "../LoadMoreButton.jsx";
import PhotoGrid from "../PhotoGrid.jsx";
import ConfirmDeleteDialog from "../ConfirmDeleteDialog.jsx";

// Kept in step with the backend's per-request cap (`api.imaging`'s
// MAX_PHOTOS_PER_UPLOAD) so we stop before a doomed request rather than after a
// 400 — the same reason, and the same number, as `ComposeBox`'s MAX_IMAGES. The
// *album*'s cap (MAX_PHOTOS_PER_EVENT = 200) is the server's alone: it's counted
// over everyone's photos, including the ones this viewer isn't allowed to see,
// so the client cannot know how close it is.
const MAX_PER_UPLOAD = 10;

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
  // How many of the files you picked didn't fit in one upload (see `onPick`).
  const [trimmed, setTrimmed] = useState(0);
  // Whether to page the album out to its end — armed by a successful upload.
  const [showWholeAlbum, setShowWholeAlbum] = useState(false);

  // ⚠️ **This key holds one shape: an infinite query's `{pages, pageParams}`.**
  // Nothing else may cache the bare page under it — a plain `useQuery` here and
  // an infinite one there is one cache entry with two incompatible shapes, and
  // whichever mounts second reads the other's answer. `EventTimelineEntry` used
  // to, and the event page opened after a card blanked the whole app.
  const photosQuery = useInfiniteList(["eventPhotos", eventId], () =>
    api.getEventPhotos(eventId)
  );
  const photos = photosQuery.items;

  // After an upload lands, walk the album out to its last page.
  //
  // The album is ordered oldest-first, so photos you add join the **end** of it
  // — which on an album of more than one page is a page nobody has loaded. The
  // count in the heading ticked up, the grid didn't move, and the only other
  // visible change was a "Load more" button quietly appearing: from where the
  // person standing there is looking, a successful upload did nothing at all,
  // so they press Add again and spend the 200-photo cap twice. (`useInfiniteList`
  // refetches only the pages already loaded, which is right for every other list
  // in the app, where new rows arrive at the top.)
  //
  // Bounded by the same cap: 200 photos is ten pages, and only for someone who
  // has just added to a nearly-full album. It stays armed for the rest of the
  // visit rather than for one upload — you're now the person most likely to add
  // another, and re-arming per upload would race the invalidation it's chasing.
  useFetchAllPages(photosQuery, showWholeAlbum);

  const add = useMutation({
    mutationFn: (files) => api.addEventPhotos(eventId, files),
    onSuccess: () => {
      setError(null);
      setShowWholeAlbum(true);
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
    if (!files.length) return;
    // Stop at the server's per-request cap rather than after it, the same way
    // both post composers do (`ComposeBox`, `MAX_IMAGES`). "Select all" in a
    // phone's picker is one tap, and without this the browser uploads thirty
    // full-size photos — tens of megabytes, minutes on a phone connection —
    // for the server to reject the lot and save none of them. Over a hundred
    // files it's worse: Django's `DATA_UPLOAD_MAX_NUMBER_FILES` trips before
    // the view runs, so even the explanation is lost.
    setTrimmed(Math.max(files.length - MAX_PER_UPLOAD, 0));
    add.mutate(files.slice(0, MAX_PER_UPLOAD));
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

      {trimmed > 0 && (
        <p role="status" className="mb-3 text-sm text-ink-soft">
          Photos go up {MAX_PER_UPLOAD} at a time, so {trimmed} of the ones you
          picked weren&rsquo;t added. Pick those again to add the rest.
        </p>
      )}

      {/* Three states, not two. `isLoading` is `isPending && isFetching` in
          TanStack v5, so a query that has *failed* is not loading and has no
          items — which used to fall through to the empty state and render the
          error line beside it, telling you in one breath that the album is
          empty and that we couldn't read it. The empty state is a claim about
          the server's answer, so it may only be made when there was one. */}
      {photosQuery.isLoading ? (
        <p className="text-sm text-ink-faint">Loading photos…</p>
      ) : photosQuery.isError && photos.length === 0 ? (
        <p className="text-sm text-red-600">Couldn&rsquo;t load the photos.</p>
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
          {photosQuery.isError && (
            // The partial case: a list that stopped short is indistinguishable
            // from one that ended, and here that silently under-states the
            // album. Below the rows, because what it's qualifying is the rows.
            <p className="mt-2 text-sm text-red-600">
              Couldn&rsquo;t load all the photos.
            </p>
          )}
        </>
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
