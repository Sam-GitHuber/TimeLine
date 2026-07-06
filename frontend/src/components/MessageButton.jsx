import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { api } from "../api.js";

// "Message" on a connected person's profile. Opens (get-or-creates) the 1:1
// conversation with them, then navigates to the thread. Only rendered when
// you're connected — the backend also enforces that (403 otherwise).
export default function MessageButton({ userId }) {
  const navigate = useNavigate();

  const mutation = useMutation({
    mutationFn: () => api.openConversation(userId),
    onSuccess: (conversation) => navigate(`/messages/${conversation.id}`),
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
