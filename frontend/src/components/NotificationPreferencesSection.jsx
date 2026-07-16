import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";

// The "Notifications" section on the settings page (Phase 8). The API returns a
// { kind: bool } map over just the *mutable* kinds — the connection/invite kinds
// are always-on and never appear here (you can't miss "someone wants to
// connect"). Toggling a kind off means no notification of that kind is created
// at all (and, later, no push).
//
// Friendly labels for each kind. If the backend ever adds a new mutable kind, it
// still renders (falling back to the raw key), so a missing label degrades
// gracefully rather than dropping the toggle.
const LABELS = {
  post_reply: "Replies to your posts",
  comment_reply: "Replies to your comments",
  reaction: "Reactions to your posts and comments",
  // Group events (Phase 8b) — mutable, default-on.
  event_created: "New events in your groups",
  poll_opened: "Polls opened on events",
  event_scheduled: "When an event's date is set",
  event_updated: "Changes to events you're going to",
  event_cancelled: "Events being cancelled",
};

export default function NotificationPreferencesSection() {
  const queryClient = useQueryClient();

  const { data: prefs, isLoading } = useQuery({
    queryKey: ["notificationPreferences"],
    queryFn: api.getNotificationPreferences,
  });

  const mutation = useMutation({
    mutationFn: (patch) => api.updateNotificationPreferences(patch),
    onMutate: async (patch) => {
      // Optimistic: flip the toggle immediately, roll back on failure.
      await queryClient.cancelQueries({ queryKey: ["notificationPreferences"] });
      const previous = queryClient.getQueryData(["notificationPreferences"]);
      queryClient.setQueryData(["notificationPreferences"], (old) => ({
        ...old,
        ...patch,
      }));
      return { previous };
    },
    onError: (_err, _patch, context) => {
      if (context?.previous) {
        queryClient.setQueryData(
          ["notificationPreferences"],
          context.previous
        );
      }
    },
    onSuccess: (data) => {
      // The server returns the full merged map — treat it as the source of truth.
      queryClient.setQueryData(["notificationPreferences"], data);
    },
  });

  const entries = prefs ? Object.entries(prefs) : [];

  return (
    <section className="mt-10 border-t border-line pt-6">
      <h2 className="font-display text-lg font-semibold -tracking-[0.01em] text-ink">
        Notifications
      </h2>
      <p className="mt-1 text-sm text-ink-soft">
        Choose what shows up in your activity centre. Connection requests and
        group invitations always notify you.
      </p>

      {isLoading ? (
        <p className="mt-4 text-sm text-ink-faint">Loading…</p>
      ) : (
        <ul className="mt-4 max-w-sm divide-y divide-line">
          {entries.map(([kind, enabled]) => (
            <li
              key={kind}
              className="flex items-center justify-between gap-4 py-3"
            >
              <span className="text-sm text-ink">{LABELS[kind] || kind}</span>
              <Toggle
                checked={enabled}
                disabled={mutation.isPending}
                onChange={(next) => mutation.mutate({ [kind]: next })}
                label={LABELS[kind] || kind}
              />
            </li>
          ))}
        </ul>
      )}

      {mutation.isError && (
        <p role="alert" className="mt-3 text-sm text-red-600">
          Couldn’t save that preference. Please try again.
        </p>
      )}
    </section>
  );
}

// A small accessible switch: a real checkbox for semantics/keyboard, styled as a
// track + knob with the design tokens.
function Toggle({ checked, disabled, onChange, label }) {
  return (
    <label className="relative inline-flex cursor-pointer items-center">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={label}
        className="peer sr-only"
      />
      <span className="h-6 w-11 rounded-full bg-line-strong transition-colors peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent-tint peer-disabled:opacity-50" />
      <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5" />
    </label>
  );
}
