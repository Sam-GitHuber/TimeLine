import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api.js";

// "Plan an event" — the low-friction first step. Any active member can create an
// event with just a title (title + date is enough to be real; time, place and
// custom questions get set or polled after). On success we go straight to the
// event page so the organiser can light up the dimension chips.
export default function PlanEventForm({ groupId, onClose }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: () => api.createEvent(groupId, { title: title.trim(), description }),
    onSuccess: (event) => {
      queryClient.invalidateQueries({ queryKey: ["groupEvents", groupId] });
      navigate(`/g/${groupId}/events/${event.id}`);
    },
  });

  return (
    <form
      className="rounded-xl border border-line bg-raised p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) create.mutate();
      }}
    >
      <label className="block text-sm font-medium text-ink">
        What are you planning?
        <input
          type="text"
          value={title}
          maxLength={200}
          autoFocus
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Grandma's 80th"
          className="mt-1 w-full rounded-md border border-line-strong bg-raised px-3 py-2"
        />
      </label>
      <label className="mt-3 block text-sm font-medium text-ink">
        Details <span className="font-normal text-ink-faint">(optional)</span>
        <textarea
          value={description}
          maxLength={5000}
          rows={2}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Anything worth saying up front"
          className="mt-1 w-full rounded-md border border-line-strong bg-raised px-3 py-2"
        />
      </label>
      {create.isError && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {create.error?.message || "Couldn't create the event."}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <button
          type="submit"
          disabled={!title.trim() || create.isPending}
          className="btn btn-primary btn-sm"
        >
          Plan an event
        </button>
        <button type="button" onClick={onClose} className="btn btn-ghost btn-sm">
          Cancel
        </button>
      </div>
    </form>
  );
}
