import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { serverMessage } from "../errors.js";
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

// A connection control reflecting the private, mutual connection flow.
// `connectionStatus` is one of "none" | "requested" | "incoming" | "connected":
//   none      → "Connect"   → sends a connection request
//   requested → "Requested" → you asked; click to withdraw
//   incoming  → "Approve"   → they asked you; click to accept (mutual)
//   connected → "Connected" → click to disconnect
// Both "Connect" and "Approve" call api.connect: for an incoming request the
// backend accepts the existing request instead of making a second one.
// On success it invalidates the people list, feed, that user's profile, and the
// connection-requests inbox so every view reflects the change.
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["connections"] });
      queryClient.invalidateQueries({ queryKey: ["feed"] });
      queryClient.invalidateQueries({ queryKey: ["user", userId] });
      queryClient.invalidateQueries({ queryKey: ["connectionRequests"] });
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });

  // Awaited rather than fired-and-forgotten so the disconnect path can keep its
  // warning dialog up until the write lands, and show the failure there instead
  // of closing over it — see DisconnectWarningModal.
  async function run() {
    const fallback = FAILURES[connectionStatus] ?? FAILURES.none;
    setFailure(null);
    try {
      await mutation.mutateAsync();
      setShowWarning(false);
    } catch (err) {
      // Here the server's own words are worth showing: ConnectView rejects with
      // sentences written for a person ("You can't connect with this person."
      // when a block bars it), which say more than any fallback could.
      setFailure(serverMessage(err, fallback));
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
            {failure}
          </span>
        )}
      </span>
      {showWarning && (
        <DisconnectWarningModal
          userId={userId}
          userName={displayName}
          action="disconnect"
          busy={mutation.isPending}
          error={failure}
          onConfirm={run}
          onCancel={() => setShowWarning(false)}
        />
      )}
    </>
  );
}
