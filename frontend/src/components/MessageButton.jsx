import { useMutation } from "@tanstack/react-query";
import { api } from "../api.js";
import { serverMessage } from "../errors.js";
import { useMessaging } from "../messaging.jsx";

// "Message" on a connected person's profile. Opens (get-or-creates) the 1:1
// conversation with them, then reveals it in the messages drawer — so you stay
// on their profile with the thread alongside, rather than being navigated away.
// Only rendered when you're connected; the backend enforces the same rule.
//
// A rejection is reported beneath the button (issue #236). Without it the label
// simply flipped from "Opening…" back to "Message" with no drawer — a tap that
// silently did nothing, which is indistinguishable from having missed the
// button. `isError` is read straight off the mutation, as PendingChatPanel does
// for its own Connect: react-query clears it on the next attempt, so there's no
// state here to keep in step.
export default function MessageButton({ userId }) {
  const { openThread } = useMessaging();

  const mutation = useMutation({
    mutationFn: () => api.openConversation(userId),
    onSuccess: (conversation) => openThread(conversation.id),
  });

  return (
    // A column so the message stacks under the button rather than competing
    // with it for width in the profile's horizontal action row.
    <span className="inline-flex shrink-0 flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending}
        className="btn btn-primary btn-sm"
      >
        {mutation.isPending ? "Opening…" : "Message"}
      </button>
      {mutation.isError && (
        <span
          role="alert"
          className="max-w-56 text-right text-xs leading-snug text-red-600"
        >
          {serverMessage(mutation.error, "Couldn’t open that chat — try again.")}
        </span>
      )}
    </span>
  );
}
