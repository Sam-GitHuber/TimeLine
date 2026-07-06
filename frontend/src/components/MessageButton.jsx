import { useMutation } from "@tanstack/react-query";
import { api } from "../api.js";
import { useMessaging } from "../messaging.jsx";

// "Message" on a connected person's profile. Opens (get-or-creates) the 1:1
// conversation with them, then reveals it in the messages drawer — so you stay
// on their profile with the thread alongside, rather than being navigated away.
// Only rendered when you're connected; the backend enforces the same rule.
export default function MessageButton({ userId }) {
  const { openThread } = useMessaging();

  const mutation = useMutation({
    mutationFn: () => api.openConversation(userId),
    onSuccess: (conversation) => openThread(conversation.id),
  });

  return (
    <button
      type="button"
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
      className="btn btn-primary btn-sm shrink-0"
    >
      {mutation.isPending ? "Opening…" : "Message"}
    </button>
  );
}
