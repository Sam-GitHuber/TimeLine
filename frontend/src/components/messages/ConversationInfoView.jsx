import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Avatar from "../Avatar.jsx";
import BlockButton from "../BlockButton.jsx";
import Lightbox from "../Lightbox.jsx";
import { PanelHeader } from "../drawer-chrome.jsx";
import AvatarStack from "./AvatarStack.jsx";
import { api } from "../../api.js";
import { useAuth } from "../../auth.jsx";
import { serverMessage } from "../../errors.js";
import { useHoldMessagesOpen, useMessaging } from "../../messaging.jsx";

/**
 * A conversation's info panel (Phase 9b M9e, porting the app's M6 info screen) —
 * everything *about* a chat, as opposed to what was said in it.
 *
 * **Why it exists.** The thread header had grown Mute, Add and Leave as three
 * icon buttons competing with the name of the person you're talking to, which is
 * the one thing a chat header is for. Moving them here is both the standard
 * shape and simply better: the header becomes identity + `⋯`, and the actions
 * get room to say what they do. It's also the only place a **group can be
 * renamed** — until now a title was fixed at creation, so "Weekend plans"
 * outlived the weekend.
 *
 * What's here: identity (the group's editable name, or the other person through
 * to their profile), the participant list with a **Pending** badge, the media
 * gallery, Mute, Add people, Leave, and — on a 1:1 — Block.
 *
 * A fourth drawer *view*, not a route: see `messaging.jsx`.
 */
export default function ConversationInfoView() {
  const { conversationId, openThread, openList, openNew } = useMessaging();
  const { user: me } = useAuth();
  const queryClient = useQueryClient();
  /** The in-progress rename, or null when the name is just being displayed. */
  const [draftTitle, setDraftTitle] = useState(null);

  /**
   * The same query key the thread uses, so opening this costs nothing when you
   * arrived from there and any change made here is on the thread's header the
   * moment you go back.
   *
   * Not polled: this panel shows membership and settings, which change when
   * *you* change them, and the read receipts that make the thread poll the same
   * payload have nothing to draw here.
   */
  const convoQuery = useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: () => api.getConversation(conversationId),
  });
  const detail = convoQuery.data;
  const isGroup = detail?.kind === "group";
  const canRename = isGroup && detail?.my_status === "active";
  const other = detail?.other;
  const participants = detail?.participants ?? [];

  /**
   * The other person's profile — for the Block control, which needs to know
   * whether you've already blocked them.
   *
   * One extra request, only on a 1:1, and only on this panel. Blocking is
   * reachable from a profile too, and always has been; having it here as well is
   * the point of an info panel — the moment you want to block someone is usually
   * the moment you're looking at what they sent.
   */
  const otherQuery = useQuery({
    queryKey: ["user", other?.id],
    queryFn: () => api.getUser(other.id),
    enabled: !!other?.id,
  });

  const renameMutation = useMutation({
    mutationFn: (title) => api.renameConversation(conversationId, title),
    onSuccess: (updated) => {
      setDraftTitle(null);
      // Write the server's copy straight into the cache the thread header reads
      // from, so the new name is up before any refetch lands. Then refresh the
      // list — where the row's *name* is the only thing that changed, since a
      // rename deliberately doesn't reorder it.
      queryClient.setQueryData(["conversation", conversationId], updated);
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });

  const muteMutation = useMutation({
    mutationFn: (muted) => api.setConversationMuted(conversationId, muted),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["conversation", conversationId],
      });
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });

  const leaveMutation = useMutation({
    mutationFn: () => api.leaveConversation(conversationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      queryClient.invalidateQueries({ queryKey: ["unreadMessages"] });
      // **To the list, not back to the thread.** Going back would land on the
      // transcript of a conversation you're no longer in, which is a 403 waiting
      // to happen.
      openList();
    },
  });

  /**
   * All three writes on this panel are reported *here* and nowhere else, so the
   * drawer's Escape, ✕ and Back — and the Back to the transcript, which unmounts
   * this panel just as completely — hold while any of them is out (#258, #238).
   *
   * The rename was the only one until #238; mute and leave said nothing at all
   * when they failed, so there was nothing to hold for. `MessagesDrawer`'s own
   * comment is right that this panel holds nothing worth preserving across a
   * visit — that's a judgement about the *draft*. Abandoning a rename you
   * haven't sent is free; abandoning one the server is about to refuse is the
   * bug, and the same now goes for the other two.
   */
  useHoldMessagesOpen(
    renameMutation.isPending ||
      muteMutation.isPending ||
      leaveMutation.isPending
  );

  const groupName =
    detail?.title ||
    participants
      .filter((person) => person.id !== me?.pk)
      .map((person) => person.display_name)
      .join(", ") ||
    "Group chat";

  return (
    <>
      <PanelHeader onBack={() => openThread(conversationId)}>
        <h2 className="truncate font-display text-lg font-bold -tracking-[0.02em] text-ink">
          Details
        </h2>
      </PanelHeader>

      {convoQuery.isLoading ? (
        <p className="flex-1 px-5 py-10 text-center text-ink-faint">Loading…</p>
      ) : !detail ? (
        <div className="flex-1 px-6 py-16 text-center text-ink-faint">
          <p className="font-medium text-ink">
            This conversation isn’t available.
          </p>
          <button
            type="button"
            onClick={openList}
            className="btn btn-ghost btn-sm mt-4"
          >
            Back to messages
          </button>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto pb-8">
          <div className="flex flex-col items-center gap-1.5 px-5 py-6 text-center">
            {isGroup ? (
              <AvatarStack participants={participants} max={3} />
            ) : (
              <Avatar user={other} size="lg" />
            )}

            {draftTitle !== null ? (
              // Editing in place rather than on a panel of its own: it's one
              // field, and a round trip through a form would be more navigation
              // than the change deserves.
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  renameMutation.mutate(draftTitle.trim());
                }}
                className="mt-1 flex w-full items-center gap-2"
              >
                <input
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  placeholder="Name this chat"
                  aria-label="Chat name"
                  maxLength={100}
                  autoFocus
                  className="min-w-0 flex-1 rounded-xl border border-line-strong bg-raised px-3 py-1.5 text-sm text-ink transition placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-tint"
                />
                <button
                  type="button"
                  onClick={() => setDraftTitle(null)}
                  className="btn btn-ghost btn-sm"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={renameMutation.isPending}
                  className="btn btn-primary btn-sm"
                >
                  {renameMutation.isPending ? "Saving…" : "Save"}
                </button>
              </form>
            ) : (
              <>
                <p className="font-display text-lg font-bold -tracking-[0.02em] text-ink">
                  {isGroup ? groupName : other?.display_name ?? "Conversation"}
                </p>
                {canRename && (
                  <button
                    type="button"
                    // Blank clears the title, and both clients then fall back to
                    // the members' names — so the field starts from the *stored*
                    // title, not from the fallback shown above it, or "cancel a
                    // rename by clearing it" would be impossible to express.
                    onClick={() => setDraftTitle(detail.title ?? "")}
                    className="text-sm font-medium text-accent-deep transition hover:underline"
                  >
                    Rename
                  </button>
                )}
                {!isGroup && other && (
                  <Link
                    to={`/u/${other.id}`}
                    className="text-sm font-medium text-accent-deep transition hover:underline"
                  >
                    View profile
                  </Link>
                )}
              </>
            )}
            {renameMutation.isError && (
              <p role="alert" className="text-sm text-red-600">
                {serverMessage(
                  renameMutation.error,
                  "Couldn’t rename this chat."
                )}
              </p>
            )}
            {detail.group && (
              <p className="text-sm text-ink-faint">
                In the group {detail.group.name}
              </p>
            )}
          </div>

          <Section
            title={isGroup ? `${participants.length} people` : "In this chat"}
          >
            {participants.map((person) => (
              <PersonRow key={person.id} person={person} meId={me?.pk} />
            ))}
          </Section>

          <MediaGallery conversationId={conversationId} />

          <Section title="Settings">
            <div className="flex items-center gap-3 px-5 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink">
                  {/* Mute reads as its state, not as an imperative — a muted
                      thread should say so, since the whole risk of muting is
                      forgetting you did. It silences the *push* only: the thread
                      keeps its unread badge either way. */}
                  {detail.muted ? "Muted" : "Mute notifications"}
                </p>
                <p className="text-xs text-ink-faint">
                  {detail.muted
                    ? "This chat won’t buzz your phone. It still shows unread."
                    : "Stop this chat buzzing your phone."}
                </p>
              </div>
              <button
                type="button"
                onClick={() => muteMutation.mutate(!detail.muted)}
                disabled={muteMutation.isPending}
                role="switch"
                aria-checked={!!detail.muted}
                aria-label="Mute notifications"
                className="btn btn-ghost btn-sm shrink-0"
              >
                {detail.muted ? "On" : "Off"}
              </button>
            </div>

            {/* #238 — the one that lied hardest. The switch reads `detail.muted`
                straight from the server, so it deliberately doesn't move until
                the write lands; what it did instead was not move and not say
                why, making a mute that 500'd pixel-identical to one that worked.
                You believe a noisy group chat is silenced and your phone buzzes
                all evening with nothing to suggest the app is at fault.
                `ConversationListView` names this exact failure in its own
                comment and handles it; this panel didn't. */}
            {muteMutation.isError && (
              <p role="alert" className="px-5 pb-2 text-sm text-red-600">
                {serverMessage(
                  muteMutation.error,
                  muteMutation.variables
                    ? "Couldn’t mute this chat."
                    : "Couldn’t unmute this chat."
                )}
              </p>
            )}

            {isGroup && (
              <button
                type="button"
                onClick={() =>
                  openNew({ addToConversationId: conversationId })
                }
                className="block w-full px-5 py-2.5 text-left transition hover:bg-accent-tint/40"
              >
                <span className="block text-sm font-semibold text-ink">
                  Add people
                </span>
                <span className="block text-xs text-ink-faint">
                  Anyone you’re connected with. They join once they’re connected
                  to everyone here.
                </span>
              </button>
            )}
          </Section>

          {/* Rendered only when it has something in it. A `Section` draws a rule
              across the panel, so an unconditional one left a stray line under a
              1:1 for as long as the profile behind the Block control was still
              loading. */}
          {(isGroup || (other && otherQuery.data)) && (
          <Section>
            {isGroup && (
              /* Leaving unmounts this panel and so would drop a rename still in
                 flight — deliberately not held on `renameMutation.isPending`,
                 unlike the drawer's chrome. It asks first and means it: someone
                 who confirms "leave this chat" has decided the chat is over, and
                 what its name ended up being is no longer an answer they'd act
                 on. Same reading as the thread header's Leave. */
              <button
                type="button"
                onClick={() => {
                  if (
                    window.confirm(
                      "Leave this chat? You’ll stop receiving messages here."
                    )
                  ) {
                    leaveMutation.mutate();
                  }
                }}
                disabled={leaveMutation.isPending}
                className="block w-full px-5 py-2.5 text-left transition hover:bg-accent-tint/40"
              >
                <span className="block text-sm font-semibold text-red-600">
                  Leave chat
                </span>
                <span className="block text-xs text-ink-faint">
                  You’ll stop receiving messages here.
                </span>
              </button>
            )}

            {/* #238: `openList()` runs only on success, so a refused leave left
                you looking at the Details panel of a chat you'd just confirmed
                leaving, with nothing said. The natural reading is that the
                button is broken — and the natural response is to press it
                again. */}
            {leaveMutation.isError && (
              <p role="alert" className="px-5 pb-2 text-sm text-red-600">
                {serverMessage(leaveMutation.error, "Couldn’t leave this chat.")}
              </p>
            )}

            {/* Block is the strong, explicit cut — it severs the connection,
                hides the thread from both of you and bars re-connecting. The
                shared control owns the warning modal, so this panel doesn't hold
                a second copy of what blocking costs. */}
            {!isGroup && other && otherQuery.data && (
              <div className="px-5 py-2.5">
                <BlockButton
                  userId={other.id}
                  displayName={other.display_name}
                  isBlocked={otherQuery.data.is_blocked}
                />
              </div>
            )}
          </Section>
          )}
        </div>
      )}
    </>
  );
}

function Section({ title, children }) {
  return (
    <div className="mt-2 border-t border-line pt-2">
      {title && (
        <p className="px-5 py-1 text-[0.7rem] font-bold uppercase tracking-wide text-ink-faint">
          {title}
        </p>
      )}
      {children}
    </div>
  );
}

function PersonRow({ person, meId }) {
  const isMe = person.id === meId;
  const body = (
    <>
      <Avatar user={person} size="sm" />
      <span className="min-w-0 flex-1 truncate text-sm text-ink">
        {person.display_name}
        {isMe ? " (you)" : ""}
      </span>
      {person.status === "pending" && (
        // Not "hasn't replied" — a pending member is waiting on *connections*,
        // which is the clique invariant doing its job rather than someone
        // ignoring an invitation. See connections.md.
        <span className="shrink-0 rounded-full border border-line-strong px-2 py-0.5 text-[0.68rem] font-bold text-ink-faint">
          Pending
        </span>
      )}
    </>
  );

  if (isMe) {
    return <div className="flex items-center gap-3 px-5 py-2">{body}</div>;
  }
  return (
    <Link
      to={`/u/${person.id}`}
      className="flex items-center gap-3 px-5 py-2 transition hover:bg-accent-tint/40"
    >
      {body}
    </Link>
  );
}

/**
 * Every photo in this chat, newest first (Phase 9b M9e) — the answer to "the
 * picture someone sent last week" without scrolling a year of transcript.
 *
 * **It renders nothing at all when there are no photos**, rather than an empty
 * state — a heading over a blank square is a feature announcing that it has
 * nothing for you. A chat that has never carried a picture simply doesn't have
 * this section, and it appears the first time one is sent.
 *
 * 🔒 It reads the *messages* endpoint with a `media=1` filter, not a gallery
 * endpoint of its own, so the photos here are the same interval-clipped set the
 * transcript draws from and the gallery can't become a way to see round a gap in
 * someone's membership. See `getConversationMedia`.
 *
 * One page, deliberately: this is a summary panel inside a scroller, and a
 * second paging list inside it would be two things competing for the same
 * scroll. A page is 20 photos, which at family scale is most chats entirely —
 * and the transcript is still there for older ones.
 */
function MediaGallery({ conversationId }) {
  const [lightboxIndex, setLightboxIndex] = useState(null);

  const mediaQuery = useQuery({
    queryKey: ["conversation-media", conversationId],
    queryFn: () => api.getConversationMedia(conversationId),
  });

  // Flattened out of their messages: the grid is about pictures, not about which
  // message each arrived in. Ordering follows the response (newest message
  // first), so the newest photo is top-left.
  const photos = (mediaQuery.data?.results ?? []).flatMap(
    (message) => message.attachments ?? []
  );
  if (photos.length === 0) return null;

  /**
   * How many photos the chat holds, which is **not** how many are drawn below.
   *
   * The grid is one page; the heading is a fact about the conversation, so it
   * comes from the paginated `count` rather than from `photos.length` — which
   * would tell someone with sixty photos that they have twenty, in a confident
   * voice, because that's how many fit on a page.
   *
   * `count` counts *messages* carrying a photo. That's the same number while
   * `MESSAGE_ATTACHMENTS_MAX` is 1; if that cap is ever raised this becomes an
   * undercount and wants a real photo count from the server rather than a fudge
   * here.
   */
  const total = mediaQuery.data?.count ?? photos.length;

  return (
    <Section title={total === 1 ? "1 photo" : `${total} photos`}>
      <div className="flex flex-wrap gap-1.5 px-5 py-1.5">
        {photos.map((photo, index) => (
          <button
            key={photo.id}
            type="button"
            onClick={() => setLightboxIndex(index)}
            aria-label={`Photo ${index + 1} of ${photos.length}`}
            className="transition hover:opacity-85"
          >
            <img
              src={photo.thumbnail}
              alt=""
              className="h-[104px] w-[104px] rounded-xl bg-ink/[0.04] object-cover"
            />
          </button>
        ))}
      </div>

      {/* Here the viewer *is* a gallery — ← / → flip between the chat's photos,
          which is exactly what you came to this panel to do. (From a bubble it
          opens the single photo, because there the message is the unit.) */}
      {lightboxIndex !== null && (
        <Lightbox
          images={photos.map((photo) => ({
            id: photo.id,
            image: photo.url,
            thumbnail: photo.thumbnail,
          }))}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </Section>
  );
}
