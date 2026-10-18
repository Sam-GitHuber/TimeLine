import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../../api.js";
import { useAuth } from "../../auth.jsx";
import { serverMessage } from "../../errors.js";
import { formatAbsoluteTime, formatRelativeTime } from "../../utils.js";
import Avatar from "../Avatar.jsx";
import { useEscapeLayer, useScrollLock } from "../modalLayer.js";

// The event's **Manage** dialog (issue #419) — everything about *running* the
// event behind one button instead of scattered down the page:
//
// - **Co-organisers.** The organiser sees who's helping, removes them, and adds
//   more from a picker of exactly the people the server will accept
//   (`getCoOrganiserCandidates` — connected group members). A co-organiser sees
//   that they're helping and can **step down**.
// - **Remind people who haven't answered** (#417) — the organisers. One row for
//   the RSVP and one per open poll, each a count (never names — a co-organiser
//   needn't be connected to everyone it reaches) and a button the server lets
//   you press once a day per row.
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

  // `is_organiser` is absent on a server from before co-organisers, where
  // `can_manage` still means "the organiser" — so only an explicit `false`
  // makes someone a co-organiser. Reading absence as "not the organiser" would
  // offer the organiser *Step down as co-organiser* of their own event.
  const isOrganiser = event.is_organiser === true;
  const isCoOrganiser = event.is_organiser === false && event.can_manage;
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

  // Reminders (#417). Fetched each time the dialog opens, so the counts and
  // "reminded 3h ago" are as fresh as the press they inform — and `gcTime: 0`
  // drops the answer when the dialog closes, so reopening shows "Loading…"
  // rather than last time's buttons (one of which someone else may have used
  // since, which would only earn a 429).
  const canRemind = event.can_manage && event.status !== "cancelled";
  const reminders = useQuery({
    queryKey: ["eventReminders", event.id],
    queryFn: () => api.getEventReminders(event.id),
    enabled: canRemind,
    gcTime: 0,
  });
  // Which row a send was about and how it went: the one mutation serves every
  // row, so its outcome is pinned to the row that was pressed. `null` is the
  // RSVP row; a number is a poll.
  const [sent, setSent] = useState(null);
  const remind = useMutation({
    mutationFn: (pollId) => api.sendEventReminder(event.id, pollId),
    onMutate: () => setSent(null),
    onSuccess: (data, pollId) => {
      setSent({ pollId, count: data.sent_count });
      reminders.refetch();
    },
    // A refusal (most often the 429 of a reminder someone else just sent)
    // means the panel is out of date too — refetch so the button greys.
    onError: () => reminders.refetch(),
  });

  const busy =
    add.isPending ||
    remove.isPending ||
    cancel.isPending ||
    destroy.isPending ||
    remind.isPending;

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

        {canRemind && (reminders.isLoading || reminders.data?.available !== false) && (
          <section className="mt-4 border-t border-line pt-4">
            <h3 className="font-display text-base font-semibold text-ink">
              Remind people who haven't answered
            </h3>
            <p className="mt-1 text-sm text-ink-soft">
              Sends them one notification from {isOrganiser ? "you" : event.organiser.display_name}.
              You can remind about each thing once a day.
            </p>
            {reminders.isLoading ? (
              <p className="mt-3 text-sm text-ink-faint">Loading…</p>
            ) : reminders.isError && !reminders.data ? (
              <p role="alert" className="mt-3 text-sm text-red-600">
                {serverMessage(reminders.error, "Couldn't load who hasn't answered.")}
              </p>
            ) : (
              <ul className="mt-3 space-y-3">
                <ReminderRow
                  label="Are you going?"
                  unanswered="replied"
                  row={reminders.data.rsvp}
                  pollId={null}
                  busy={busy}
                  remind={remind}
                  sent={sent}
                />
                {reminders.data.polls.map((poll) => (
                  <ReminderRow
                    key={poll.poll_id}
                    label={poll.question}
                    unanswered="voted"
                    row={poll}
                    pollId={poll.poll_id}
                    busy={busy}
                    remind={remind}
                    sent={sent}
                  />
                ))}
              </ul>
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

const people = (n) => (n === 1 ? "1 person" : `${n} people`);

// "3h ago" / "just now". A reminder is at most a day old while it matters, but
// an older one falls through to formatRelativeTime's date as it is.
const ago = (iso) => {
  const short = formatRelativeTime(iso);
  return /^\d+[mhd]$/.test(short) ? `${short} ago` : short;
};

// One thing that can be reminded about — the RSVP or one open poll. States
// how many haven't answered, when it was last reminded about, and holds the
// button shut while the server's daily limit stands (it'd only answer 429).
// A send's success or refusal is written under the row that was pressed.
function ReminderRow({ label, unanswered, row, pollId, busy, remind, sent }) {
  const pending = row.pending_count;
  const limited = row.next_allowed_at != null;
  const mine = remind.variables === pollId;
  return (
    <li className="rounded-xl border border-line px-4 py-3 text-sm">
      <p className="font-semibold text-ink">{label}</p>
      <p className="text-ink-soft">
        {pending === 0
          ? `Everyone has ${unanswered}.`
          : `${people(pending)} ${pending === 1 ? "hasn't" : "haven't"} ${unanswered} yet.`}
      </p>
      {row.closes_at && (
        <p className="text-xs text-ink-faint">
          Voting closes {formatAbsoluteTime(row.closes_at)}
        </p>
      )}
      {row.last_sent_at && (
        <p className="text-xs text-ink-faint">
          <time dateTime={row.last_sent_at} title={formatAbsoluteTime(row.last_sent_at)}>
            Reminded {ago(row.last_sent_at)}
          </time>
          {limited && ` · you can remind again ${formatAbsoluteTime(row.next_allowed_at)}`}
        </p>
      )}
      {pending > 0 && !limited && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (window.confirm(`Send a reminder to ${people(pending)}?`))
              remind.mutate(pollId);
          }}
          className="btn btn-ghost btn-sm mt-2"
        >
          {remind.isPending && mine ? "Sending…" : `Remind ${people(pending)}`}
        </button>
      )}
      {sent && sent.pollId === pollId && (
        <p role="status" className="mt-2 text-sm text-ink-soft">
          Reminder sent to {people(sent.count)}.
        </p>
      )}
      {remind.isError && mine && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {serverMessage(remind.error, "Couldn't send the reminder — try again.")}
        </p>
      )}
    </li>
  );
}
