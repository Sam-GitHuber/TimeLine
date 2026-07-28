import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";

// The "Privacy" section on the settings page (Phase 9b M4) — read receipts, and
// a natural home for the privacy switches that follow.
//
// A section of its own rather than a row under Notifications, because it isn't
// one: nothing is ever notified when someone reads a message, which is also why
// the flag lives on the user rather than in NotificationPreference (see
// docs/reference/messaging.md). Filing it under Notifications would imply
// turning it off stops something buzzing, which it doesn't.
//
// **The ticks themselves are M9 (web parity); the setting is here now.** That
// isn't an oversight — the disclosure happens whether or not this browser draws
// it, so a member who only ever uses the web still has to be able to opt out.
export default function PrivacySection() {
  const { user, refreshUser } = useAuth();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  // No fetch: it rides on the "who am I" payload the app already holds.
  const enabled = user?.send_read_receipts ?? true;

  async function toggle(next) {
    setSaving(true);
    setFailed(false);
    try {
      await api.setReadReceipts(next);
      await refreshUser();
      // The setting decides what the *server* puts in a conversation payload, so
      // every thread already loaded is now stale in both directions — its
      // participants either gained read markers or lost them.
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      queryClient.invalidateQueries({ queryKey: ["conversation"] });
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-10 border-t border-line pt-6">
      <h2 className="font-display text-lg font-semibold -tracking-[0.01em] text-ink">
        Privacy
      </h2>

      <div className="mt-4 flex max-w-sm items-start justify-between gap-4">
        <div>
          <p className="text-sm text-ink">Send read receipts</p>
          {/* Both halves said out loud, because the symmetry is the part people
              don't expect: turning this off doesn't only hide you, it also stops
              you seeing anyone else. Finding that out afterwards would feel like
              a trick. */}
          <p className="mt-1 text-sm text-ink-soft">
            Lets people see when you’ve read their messages. Turning it off also
            stops you seeing when they’ve read yours — in group chats too.
          </p>
        </div>
        <label className="relative inline-flex cursor-pointer items-center pt-0.5">
          <input
            type="checkbox"
            checked={enabled}
            disabled={saving}
            onChange={(e) => toggle(e.target.checked)}
            aria-label="Send read receipts"
            className="peer sr-only"
          />
          <span className="h-6 w-11 rounded-full bg-line-strong transition-colors peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent-tint peer-disabled:opacity-50" />
          <span className="absolute left-0.5 top-1 h-5 w-5 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5" />
        </label>
      </div>

      {failed && (
        <p role="alert" className="mt-3 text-sm text-red-600">
          Couldn’t save that. Please try again.
        </p>
      )}
    </section>
  );
}
