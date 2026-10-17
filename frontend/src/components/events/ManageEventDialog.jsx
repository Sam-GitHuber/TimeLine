import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../../api.js";
import { useAuth } from "../../auth.jsx";
import { serverMessage } from "../../errors.js";
import Avatar from "../Avatar.jsx";
import { useEscapeLayer, useScrollLock } from "../modalLayer.js";

// The event's **Manage** dialog (issue #419) — everything about *running* the
// event behind one button instead of scattered down the page:
//
// - **Co-organisers.** The organiser sees who's helping, removes them, and adds
//   more from a picker of exactly the people the server will accept
//   (`getCoOrganiserCandidates` — connected group members). A co-organiser sees
//   that they're helping and can **step down**.
// - **Cancel** — the organiser, a co-organiser or a group admin (`can_cancel`).
// - **Delete** — the organiser or a group admin only (`can_moderate`): it takes
//   everyone's album photos with it, which is why a co-organiser doesn't get it.
//
// Cancel and delete are the page's mutations, handed in as `mutateAsync`, so
// the page's one `invalidate()` and its post-delete navigate stay the only copy.
// The dialog **stays open until a write lands** and states a refusal inside
// itself — the `DisconnectWarningModal` shape (#236): closing first would leave
// a failed cancel with nowhere to be said, pixel-identical to one that worked
// (#237).
export default function ManageEventDialog({
  event,
  onClose,
  onChanged,
  onCancelEvent,
  onDeleteEvent,
}) {
  const { user } = useAuth();
  const dialogRef = useRef(null);
  const [picking, setPicking] = useState(false);

  const isOrganiser = event.is_organiser ?? false;
  const isCoOrganiser = event.can_manage && !isOrganiser;
  const canCancel =
    (event.can_cancel ?? event.can_moderate) && event.status !== "cancelled";
  const coOrganisers = event.co_organisers ?? [];

  const candidates = useQuery({
    queryKey: ["coOrganiserCandidates", event.id],
    queryFn: () => api.getCoOrganiserCandidates(event.id),
    enabled: isOrganiser && picking,
  });

  const add = useMutation({
    mutationFn: (userId) => api.addCoOrganiser(event.id, userId),
    onSuccess: () => {
      setPicking(false);
      onChanged();
    },
  });
  const remove = useMutation({
    mutationFn: (userId) => api.removeCoOrganiser(event.id, userId),
    onSuccess: () => {
      onChanged();
      // Stepping down ends your say over the event, so the dialog has nothing
      // left to offer you.
      if (!isOrganiser) onClose();
      else if (picking) candidates.refetch();
    },
  });
  const cancel = useMutation({
    mutationFn: onCancelEvent,
    onSuccess: onClose,
  });
  const destroy = useMutation({ mutationFn: onDeleteEvent });

  const busy =
    add.isPending || remove.isPending || cancel.isPending || destroy.isPending;

  // Escape closes, but not out from under a write already sent — you'd lose
  // the only place its answer can appear.
  useEscapeLayer(onClose, !busy);
  useScrollLock();
  useEffect(() => {
    const previouslyFocused = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, []);

  const stop = (e) => e.stopPropagation();

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4 backdrop-blur-sm"
      onClick={busy ? undefined : onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Manage event"
        tabIndex={-1}
        onClick={stop}
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl border border-line bg-raised p-5 shadow-xl outline-none"
      >
        <h2 className="font-display text-lg font-bold text-ink">Manage event</h2>

        {(isOrganiser || isCoOrganiser) && (
          <section className="mt-4 border-t border-line pt-4">
            <h3 className="font-display text-base font-semibold text-ink">
              Co-organisers
            </h3>
            <p className="mt-1 text-sm text-ink-soft">
              Co-organisers can set the date, time and place, run polls and
              cancel. If you leave the group, the event passes to the first one
              rather than being cancelled.
            </p>

            {coOrganisers.length === 0 && !isCoOrganiser && (
              <p className="mt-3 text-sm text-ink-faint">No co-organisers yet.</p>
            )}
            {coOrganisers.length > 0 && (
              <ul className="mt-3 space-y-2">
                {coOrganisers.map((person) => (
                  <li key={person.id} className="flex items-center gap-2 text-sm">
                    <Avatar user={person} size="xs" />
                    <span className="flex-1 text-ink">{person.display_name}</span>
                    {isOrganiser && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => remove.mutate(person.id)}
                        aria-label={`Remove ${person.display_name}`}
                        className="font-medium text-red-600 hover:underline"
                      >
                        Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {isOrganiser && !picking && (
              <button
                type="button"
                disabled={busy}
                onClick={() => setPicking(true)}
                className="btn btn-ghost btn-sm mt-3"
              >
                + Add co-organiser
              </button>
            )}

            {isOrganiser && picking && (
              <div className="mt-3 rounded-xl border border-line bg-surface p-3">
                <p className="text-sm font-semibold text-ink">Choose someone</p>
                {candidates.isLoading ? (
                  <p className="mt-2 text-sm text-ink-faint">Loading…</p>
                ) : candidates.isError && !candidates.data ? (
                  <p role="alert" className="mt-2 text-sm text-red-600">
                    {serverMessage(candidates.error, "Couldn't load who you can add.")}
                  </p>
                ) : (candidates.data ?? []).length === 0 ? (
                  <p className="mt-2 text-sm text-ink-faint">
                    Nobody else to add — a co-organiser has to be someone in this
                    group you're connected with.
                  </p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {candidates.data.map((person) => (
                      <li key={person.id} className="flex items-center gap-2 text-sm">
                        <Avatar user={person} size="xs" />
                        <span className="flex-1 text-ink">{person.display_name}</span>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => add.mutate(person.id)}
                          aria-label={`Add ${person.display_name}`}
                          className="font-semibold text-accent-deep hover:underline"
                        >
                          Add
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setPicking(false)}
                  className="mt-2 text-sm font-medium text-ink-faint hover:underline"
                >
                  Done
                </button>
              </div>
            )}

            {isCoOrganiser && user && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      `Step down as co-organiser? ${event.organiser.display_name} will still be organising it.`
                    )
                  )
                    remove.mutate(user.pk);
                }}
                className="btn btn-ghost btn-sm mt-3"
              >
                Step down as co-organiser
              </button>
            )}

            {add.isError && (
              <p role="alert" className="mt-2 text-sm text-red-600">
                {serverMessage(add.error, "Couldn't add them — try again.")}
              </p>
            )}
            {remove.isError && (
              <p role="alert" className="mt-2 text-sm text-red-600">
                {serverMessage(remove.error, "Couldn't remove them — try again.")}
              </p>
            )}
          </section>
        )}

        {(canCancel || event.can_moderate) && (
          <section className="mt-4 space-y-2 border-t border-line pt-4">
            {canCancel && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (window.confirm("Cancel this event? People who RSVP'd are notified."))
                    cancel.mutate();
                }}
                className="block w-full rounded-xl border border-line px-4 py-2 text-left hover:bg-surface"
              >
                <span className="block text-sm font-semibold text-red-600">
                  Cancel event
                </span>
                <span className="block text-xs text-ink-faint">
                  People who said they're going are told. It stays visible, marked
                  cancelled.
                </span>
              </button>
            )}
            {event.can_moderate && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (window.confirm("Delete this event for everyone? This can't be undone."))
                    destroy.mutate();
                }}
                className="block w-full rounded-xl border border-line px-4 py-2 text-left hover:bg-surface"
              >
                <span className="block text-sm font-semibold text-red-600">
                  Delete event
                </span>
                <span className="block text-xs text-ink-faint">
                  Removes it for everyone, with its photos and comments.
                </span>
              </button>
            )}
            {/* Each states its own failure: knowing *which* of the two didn't
                happen is most of the value (#237). */}
            {cancel.isError && (
              <p role="alert" className="text-sm text-red-600">
                {serverMessage(cancel.error, "Couldn't cancel the event — try again.")}
              </p>
            )}
            {destroy.isError && (
              <p role="alert" className="text-sm text-red-600">
                {serverMessage(destroy.error, "Couldn't delete the event — try again.")}
              </p>
            )}
          </section>
        )}

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="btn btn-ghost btn-sm"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
