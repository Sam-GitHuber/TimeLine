import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import Avatar from "../components/Avatar.jsx";
import DimensionChips from "../components/events/DimensionChips.jsx";
import DimensionEditor from "../components/events/DimensionEditor.jsx";
import PollTally from "../components/events/PollTally.jsx";
import RsvpBar from "../components/events/RsvpBar.jsx";
import { formatEventWhen } from "../utils.js";

const EDITOR_TITLE = {
  date: { set: "Set the date", poll: "Poll on a date" },
  time: { set: "Set the time", poll: "Poll on a time" },
  location: { set: "Set the place", poll: "Poll on a place" },
  custom: { poll: "Ask the group" },
};

// The event detail page (`/g/:id/events/:eid`) — the deep-link a notification
// opens, and the organiser's control surface. The dimension chip row is the
// heart of it: the organiser lights chips up in any order (Set a value, or open
// a Poll), members see the chips as status and vote/RSVP below.
export default function EventPage() {
  const { id, eid } = useParams();
  const groupId = Number(id);
  const eventId = Number(eid);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Which chip's editor is open: { dimension, mode: "set" | "poll" } or null.
  const [editing, setEditing] = useState(null);

  const eventQuery = useQuery({
    queryKey: ["event", eventId],
    queryFn: () => api.getEvent(eventId),
    retry: false,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["event", eventId] });
    queryClient.invalidateQueries({ queryKey: ["groupEvents", groupId] });
    queryClient.invalidateQueries({ queryKey: ["groupCalendar", groupId] });
  };
  const closeAndRefresh = () => {
    setEditing(null);
    invalidate();
  };

  const rsvp = useMutation({
    mutationFn: (body) => api.rsvpEvent(eventId, body),
    onSuccess: invalidate,
  });
  const finalise = useMutation({
    mutationFn: ({ dimension, value, optionId }) =>
      api.finaliseEvent(eventId, { dimension, value, optionId }),
    onSuccess: closeAndRefresh,
  });
  const createPoll = useMutation({
    mutationFn: ({ dimension, question, options }) =>
      api.createPoll(eventId, { dimension, question, options }),
    onSuccess: closeAndRefresh,
  });
  const vote = useMutation({
    mutationFn: ({ pollId, optionIds }) => api.votePoll(pollId, optionIds),
    onSuccess: invalidate,
  });
  const editPoll = useMutation({
    mutationFn: ({ pollId, question, options }) =>
      api.editPoll(pollId, { question, options }),
    onSuccess: invalidate,
  });
  const closePoll = useMutation({
    mutationFn: (pollId) => api.closePoll(pollId),
    onSuccess: invalidate,
  });
  const reopenPoll = useMutation({
    mutationFn: (pollId) => api.reopenPoll(pollId),
    onSuccess: invalidate,
  });
  const deletePoll = useMutation({
    mutationFn: (pollId) => api.deletePoll(pollId),
    onSuccess: invalidate,
  });
  const cancel = useMutation({
    mutationFn: () => api.cancelEvent(eventId),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteEvent(eventId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["groupEvents", groupId] });
      navigate(`/g/${groupId}`);
    },
  });

  if (eventQuery.isError) {
    return (
      <div className="px-6 py-16 text-center">
        <p className="text-lg font-medium text-ink">Event not available</p>
        <p className="mt-1 text-ink-faint">
          It may have been cancelled, or you're not connected to whoever organised
          it.
        </p>
        <Link
          to={`/g/${groupId}`}
          className="mt-4 inline-block font-medium text-accent-deep hover:underline"
        >
          ← Back to the group
        </Link>
      </div>
    );
  }
  if (eventQuery.isLoading) {
    return <p className="px-6 py-10 text-center text-ink-faint">Loading…</p>;
  }

  const event = eventQuery.data;
  const cancelled = event.status === "cancelled";
  const busy =
    finalise.isPending ||
    createPoll.isPending ||
    vote.isPending ||
    editPoll.isPending ||
    closePoll.isPending ||
    reopenPoll.isPending ||
    deletePoll.isPending;

  // A brand-new event with nothing decided yet: guide the organiser's first move.
  const nothingDecided =
    !event.event_date &&
    !event.start_time &&
    !event.location_name &&
    (event.polls || []).length === 0;

  function onChipAction(dimension, mode, pollId) {
    if (mode === "goto" && pollId) {
      const el = document.getElementById(`poll-${pollId}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    setEditing({ dimension, mode });
  }

  return (
    <div className="mx-auto max-w-2xl px-5 py-6">
      <Link
        to={`/g/${groupId}`}
        className="text-sm font-medium text-accent-deep hover:underline"
      >
        ← {event.group.name}
      </Link>

      <header className="mt-3">
        <div className="flex items-center gap-2">
          <h1 className="font-display text-2xl font-bold -tracking-[0.02em] text-ink">
            {event.title}
          </h1>
          {cancelled && <span className="ev-tag ev-tag--off">Cancelled</span>}
          {event.is_past && !cancelled && <span className="ev-tag">Happened</span>}
        </div>
        <div className="mt-1 flex items-center gap-2 text-sm text-ink-faint">
          <Avatar user={event.organiser} size="xs" />
          <span>Organised by {event.organiser.display_name}</span>
        </div>
        {event.event_date && (
          <p className="mt-2 font-mono text-ink-soft">{formatEventWhen(event)}</p>
        )}
        {event.description && (
          <p className="mt-3 whitespace-pre-wrap break-words text-ink-soft">
            {event.description}
          </p>
        )}
        {event.location_name && (
          <p className="mt-2 text-sm text-ink-soft">
            {event.location_name}
            {event.location_url && (
              <>
                {" · "}
                <a
                  href={event.location_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent-deep hover:underline"
                >
                  link
                </a>
              </>
            )}
          </p>
        )}
      </header>

      {/* The decisions: the chip row is the control surface for the organiser. */}
      {!cancelled && (
        <section className="mt-5">
          {event.can_manage && nothingDecided && !editing && (
            <p className="ev-hint">
              Nothing's set yet. Start with a date — set it now, or open a poll and
              let the group pick.
            </p>
          )}
          <DimensionChips
            event={event}
            canManage={event.can_manage}
            onAction={onChipAction}
          />

          {editing && (
            <div className="mt-3">
              <p className="mb-2 text-sm font-semibold text-ink">
                {EDITOR_TITLE[editing.dimension]?.[editing.mode]}
              </p>
              <DimensionEditor
                dimension={editing.dimension}
                mode={editing.mode}
                busy={busy}
                onSet={(dimension, value) => finalise.mutate({ dimension, value })}
                onPoll={(body) => createPoll.mutate(body)}
                onCancel={() => setEditing(null)}
              />
              {(finalise.isError || createPoll.isError) && (
                <p role="alert" className="mt-2 text-sm text-red-600">
                  {finalise.error?.message ||
                    createPoll.error?.message ||
                    "That didn't work — try again."}
                </p>
              )}
            </div>
          )}

          {event.can_manage && !editing && (
            <button
              type="button"
              onClick={() => setEditing({ dimension: "custom", mode: "poll" })}
              className="mt-3 text-sm font-medium text-accent-deep hover:underline"
            >
              + Ask the group something else
            </button>
          )}
        </section>
      )}

      {(event.polls || []).length > 0 && (
        <section className="mt-6 space-y-4 border-t border-line pt-5">
          <h2 className="font-display text-base font-semibold text-ink">Polls</h2>
          {event.polls.map((poll) => (
            <div key={poll.id} id={`poll-${poll.id}`}>
              <PollTally
                poll={poll}
                canManage={event.can_manage}
                busy={busy}
                onVote={(optionIds) => vote.mutate({ pollId: poll.id, optionIds })}
                onFinalise={(dimension, opts) => finalise.mutate({ dimension, ...opts })}
                onEdit={(payload) => editPoll.mutateAsync({ pollId: poll.id, ...payload })}
                onClose={() => closePoll.mutate(poll.id)}
                onReopen={() => reopenPoll.mutate(poll.id)}
                onDelete={() => deletePoll.mutate(poll.id)}
              />
            </div>
          ))}
        </section>
      )}

      {!cancelled && (
        <section className="mt-6 border-t border-line pt-5">
          <h2 className="mb-3 font-display text-base font-semibold text-ink">
            Are you going?
          </h2>
          <RsvpBar event={event} onRsvp={(b) => rsvp.mutate(b)} busy={rsvp.isPending} />
        </section>
      )}

      {event.can_moderate && (
        <section className="mt-8 flex flex-wrap gap-2 border-t border-line pt-5">
          {!cancelled && (
            <button
              type="button"
              disabled={cancel.isPending}
              onClick={() => {
                if (window.confirm("Cancel this event? People who RSVP'd are notified."))
                  cancel.mutate();
              }}
              className="btn btn-ghost btn-sm text-red-600"
            >
              Cancel event
            </button>
          )}
          <button
            type="button"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm("Delete this event for everyone? This can't be undone."))
                remove.mutate();
            }}
            className="btn btn-ghost btn-sm text-red-600"
          >
            Delete
          </button>
        </section>
      )}
    </div>
  );
}
