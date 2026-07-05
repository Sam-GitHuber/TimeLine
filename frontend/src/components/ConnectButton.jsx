import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";

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
export default function ConnectButton({ userId, connectionStatus }) {
  const queryClient = useQueryClient();

  const isConnectAction =
    connectionStatus === "none" || connectionStatus === "incoming";

  const mutation = useMutation({
    mutationFn: () =>
      isConnectAction ? api.connect(userId) : api.disconnect(userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["feed"] });
      queryClient.invalidateQueries({ queryKey: ["user", userId] });
      queryClient.invalidateQueries({ queryKey: ["connectionRequests"] });
    },
  });

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
    <button
      type="button"
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
      className={`btn btn-sm ${styling}`}
      title={title}
    >
      {label}
    </button>
  );
}
