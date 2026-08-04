import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { serverMessage } from "../errors.js";
import { invalidateConnectionChange } from "../connectionCache.js";
import DisconnectWarningModal from "./DisconnectWarningModal.jsx";

// What each state's failure sounds like when the server didn't say anything
// usable itself. Named per state because "it didn't work" is much less helpful
// than knowing *which* of the four things you were doing didn't work.
const FAILURES = {
  none: "Couldn’t send that request — try again.",
  incoming: "Couldn’t accept that request — try again.",
  requested: "Couldn’t withdraw that request — try again.",
  connected: "Couldn’t disconnect — try again.",
};

// Where each state lands when its action succeeds — the answer a failure
// message is retired against. Both "undo" states collapse to none: withdrawing a
// request and disconnecting both leave you unconnected.
const RESULTS = {
  none: "requested",
  incoming: "connected",
  requested: "none",
  connected: "none",
};

// A connection control reflecting the private, mutual connection flow.
// `connectionStatus` is one of "none" | "requested" | "incoming" | "connected":
//   none      → "Connect"   → sends a connection request
//   requested → "Requested" → you asked; click to withdraw
//   incoming  → "Approve"   → they asked you; click to accept (mutual)
//   connected → "Connected" → click to disconnect
// Both "Connect" and "Approve" call api.connect: for an incoming request the
// backend accepts the existing request instead of making a second one.
// On success it refreshes everything a connection gates — the whole set, not the
// slice this button happens to sit next to; see `connectionCache.js`.
//
// Disconnecting from an accepted connection can sever group chats you only
// share through them (you're dropped to pending there until reconnected with
// everyone). Withdrawing a still-pending request never had a live connection
// to break anything, so only the "connected" state routes through the warning
// modal — everything else mutates straight away, same as before.
//
// A rejection is reported in place (issue #236). Without it, a withdraw that
// 400s — they accepted, or closed their account, while your page was open —
// re-enabled a button still reading "Requested" and repainted nothing, since no
// invalidation runs on the failure path. The click read as not having
// registered, so the natural response was to press it again.
export default function ConnectButton({ userId, displayName, connectionStatus }) {
  const queryClient = useQueryClient();
  const [showWarning, setShowWarning] = useState(false);
  const [failure, setFailure] = useState(null);

  const isConnectAction =
    connectionStatus === "none" || connectionStatus === "incoming";

  const mutation = useMutation({
    mutationFn: () =>
      isConnectAction ? api.connect(userId) : api.disconnect(userId),
    // Approving on a profile is the case that made the old hand-written list a
    // bug rather than a flash: the person's timeline is mounted directly beneath
    // this button (`ProfilePage`), so refreshing `["user", id]` and not
    // `["userPosts", id]` flipped the button to "Connected" over a timeline that
    // stayed empty until you reloaded the page (#288).
    onSuccess: () => invalidateConnectionChange(queryClient, userId),
  });

  // Retire the message once the server's own answer moves to the one the
  // attempt was reaching for — the request landed and only its response was
  // lost, so "couldn't withdraw that request" would now be sitting under a
  // button that reads Connect. Only that answer clears it: a refetch bearing
  // some *third* status (they accepted, someone blocked someone) is not
  // confirmation of your attempt, and swallowing the message there is the same
  // bug again, silently. Both halves are judged against what was recorded at the
  // attempt rather than against when the sync lands, so a refetch in the same
  // render batch as the rejection can't eat the message before it's painted —
  // the trap #231 describes. Same discipline, and same render-phase shape, as
  // RsvpBar's clear-condition.
  if (
    failure &&
    connectionStatus !== failure.from &&
    connectionStatus === failure.to
  ) {
    setFailure(null);
  }

  // Awaited rather than fired-and-forgotten so the disconnect path can keep its
  // warning dialog up until the write lands, and show the failure there instead
  // of closing over it — see DisconnectWarningModal.
  async function run() {
    const from = connectionStatus;
    const fallback = FAILURES[from] ?? FAILURES.none;
    setFailure(null);
    try {
      await mutation.mutateAsync();
      setShowWarning(false);
    } catch (err) {
      // Here the server's own words are worth showing: ConnectView rejects with
      // sentences written for a person ("You can't connect with this person."
      // when a block bars it), which say more than any fallback could.
      setFailure({
        text: serverMessage(err, fallback),
        from,
        to: RESULTS[from] ?? "none",
      });
    }
  }

  function handleClick() {
    if (connectionStatus === "connected") {
      setFailure(null);
      setShowWarning(true);
      return;
    }
    run();
  }

  const label =
    {
      none: "Connect",
      requested: "Requested",
      incoming: "Approve",
      connected: "Connected",
    }[connectionStatus] ?? "Connect";

  // The two "act to connect" states get the filled accent; the two "already
  // in motion" states (requested/connected) get the quieter outline.
  const styling = isConnectAction ? "btn-primary" : "btn-ghost";

  const title = {
    requested: "Waiting for approval — click to withdraw",
    incoming: "They asked to connect — click to accept",
    connected: "Connected — click to disconnect",
  }[connectionStatus];

  return (
    <>
      {/* A column so the message stacks under the button: this control is
          dropped into the trailing slot of a person row and into a profile's
          action row, both horizontal flex containers. */}
      <span className="inline-flex flex-col items-end gap-1">
        <button
          type="button"
          onClick={handleClick}
          disabled={mutation.isPending}
          className={`btn btn-sm ${styling}`}
          title={title}
        >
          {label}
        </button>
        {/* While the dialog is up it holds the message itself. */}
        {failure && !showWarning && (
          <span
            role="alert"
            className="max-w-56 text-right text-xs leading-snug text-red-600"
          >
            {failure.text}
          </span>
        )}
      </span>
      {showWarning && (
        <DisconnectWarningModal
          userId={userId}
          userName={displayName}
          action="disconnect"
          busy={mutation.isPending}
          error={failure?.text ?? null}
          onConfirm={run}
          onCancel={() => setShowWarning(false)}
        />
      )}
    </>
  );
}
