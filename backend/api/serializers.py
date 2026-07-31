from django.contrib.auth import get_user_model
from rest_framework import serializers

from .imaging import absolute_media_url
from .models import (
    REPORT_REASON_MAX_LENGTH,
    Comment,
    Connection,
    Conversation,
    DevicePushToken,
    Event,
    EventRSVP,
    Group,
    GroupMembership,
    Message,
    MessageAttachment,
    Notification,
    Poll,
    Post,
    PostImage,
    Report,
)

User = get_user_model()

# A generous cap so a post can't be used to dump unbounded text into the DB,
# while being far more than any real status update needs. Comments share it.
POST_MAX_LENGTH = 5000


class _Everyone:
    """A "no pruning" stand-in for a set of visible reactor ids.

    Used only by **message** reactions (Phase 9b M2), where per-viewer pruning is
    not just unnecessary but wrong. A conversation's active participants are a
    clique by construction — everyone active is connected to everyone else — so
    anyone who can see a message can already see every person who could have
    reacted to it. Filtering there would hide reactions for no privacy gain and
    make two people in the same chat disagree about a shared thread.

    A sentinel rather than ``visible_ids=None`` because ``None`` already means
    the opposite (fail closed, show nothing) and reusing it would turn one
    forgotten argument into a silent leak on posts.
    """

    def __contains__(self, _user_id):
        return True


EVERYONE = _Everyone()


def summarise_reactions(reactions, visible_ids, me_id):
    """Aggregate a target's reactions into ``[{emoji, count, reacted}]``, pruned
    to who the viewer may see (Phase 7b).

    ``reactions`` is the target's (prefetched) ``Reaction`` rows. ``visible_ids``
    is the set of user ids the viewer is allowed to see — themselves plus their
    connections — mirroring the comment tree's pruning, so a reaction by someone
    the viewer isn't connected with is never counted and can't leak a stranger.
    Fail-closed: if ``visible_ids`` is ``None`` (context wasn't supplied) nothing
    is shown rather than an unpruned count. Pass ``EVERYONE`` to opt out
    deliberately — message reactions do, see that sentinel. ``reacted`` flags the
    emoji the viewer themselves used, so the UI can highlight their own reaction.

    Ordered by count (desc), then by the emoji string, so the display order is
    stable and deterministic (tests, and no jitter between polls).
    """
    if visible_ids is None:
        return []
    counts = {}
    reacted = set()
    for r in reactions:
        if r.user_id not in visible_ids:
            continue
        counts[r.emoji] = counts.get(r.emoji, 0) + 1
        if r.user_id == me_id:
            reacted.add(r.emoji)
    items = [
        {"emoji": emoji, "count": count, "reacted": emoji in reacted}
        for emoji, count in counts.items()
    ]
    items.sort(key=lambda item: (-item["count"], item["emoji"]))
    return items


def reactions_representation(obj, context):
    """The pruned reaction summary for a post or comment, from serializer context.

    Reads the target's prefetched ``reactions`` and the viewer's
    ``visible_reactor_ids`` (set by the view). Shared by ``PostSerializer`` and
    ``CommentSerializer`` so both prune identically.
    """
    request = context.get("request")
    me_id = request.user.id if request and request.user.is_authenticated else None
    return summarise_reactions(
        obj.reactions.all(), context.get("visible_reactor_ids"), me_id
    )


class AuthorSerializer(serializers.ModelSerializer):
    """The tiny slice of a user we embed in a post or expose in a list.

    Deliberately minimal: an id (for profile links), a display name, and the
    small avatar thumbnail the UI renders. No email — see ``User.display_name``
    for why we don't leak addresses.
    """

    display_name = serializers.CharField(read_only=True)
    avatar_thumb = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = ("id", "display_name", "avatar_thumb")

    def get_avatar_thumb(self, obj):
        return absolute_media_url(obj.avatar_thumb, self.context.get("request"))


class PostImageSerializer(serializers.ModelSerializer):
    """One photo on a post: the (bounded) original plus its thumbnail, as
    absolute URLs, with the original's dimensions so the client can reserve
    layout space and avoid reflow while images load."""

    image = serializers.SerializerMethodField()
    thumbnail = serializers.SerializerMethodField()

    class Meta:
        model = PostImage
        fields = ("id", "image", "thumbnail", "width", "height")

    def get_image(self, obj):
        return absolute_media_url(obj.image, self.context.get("request"))

    def get_thumbnail(self, obj):
        return absolute_media_url(obj.thumbnail, self.context.get("request"))


class PostSerializer(serializers.ModelSerializer):
    """Read + create a post.

    ``author`` is read-only and set from the logged-in user in the view — it is
    never taken from the request body, so a client can't post as someone else.
    ``images`` are read-only here; the files are uploaded as multipart and
    processed in ``PostCreateView`` (validated + metadata-stripped via
    ``api.imaging``). ``text`` is optional — a photo-only post is allowed — but
    the view still rejects a post with neither text nor a photo.
    """

    author = AuthorSerializer(read_only=True)
    text = serializers.CharField(
        max_length=POST_MAX_LENGTH, required=False, allow_blank=True, default=""
    )
    images = PostImageSerializer(many=True, read_only=True)
    # Which group this post belongs to — ``null`` for a personal-timeline post,
    # or ``{id, name}`` for a group post. The name lets the feed label a group
    # post ("in <group>") when the "include groups" view merges them in.
    # Read-only here — the view sets the group from the validated request and
    # checks membership, never trusting the body to place a post in a group.
    group = serializers.SerializerMethodField()
    # Pruned per viewer — see ``reactions_representation``. Read-only; reactions
    # are added/removed via the toggle endpoint, never in the post body.
    reactions = serializers.SerializerMethodField()
    # How many comments this viewer would see if they expanded the thread, and
    # how many of those are new since they last opened it (issue #63). Both are
    # computed once per page by the view (``comment_counts_for_posts``) and passed
    # in via ``context["comment_counts"]`` — so the feed carries them without a
    # per-post query. Absent from context (e.g. the create response) ⇒ 0, which
    # is correct for a brand-new post with no comments yet.
    comment_count = serializers.SerializerMethodField()
    new_comment_count = serializers.SerializerMethodField()

    class Meta:
        model = Post
        fields = (
            "id",
            "author",
            "text",
            "images",
            "group",
            "reactions",
            "comment_count",
            "new_comment_count",
            "created_at",
            "edited_at",
        )
        read_only_fields = (
            "id",
            "author",
            "images",
            "group",
            "reactions",
            "comment_count",
            "new_comment_count",
            "created_at",
            # Server-controlled — stamped by the update view on a real edit, never
            # written from the request body.
            "edited_at",
        )

    def get_group(self, obj):
        if obj.group_id is None:
            return None
        return {"id": obj.group_id, "name": obj.group.name}

    def get_reactions(self, obj):
        return reactions_representation(obj, self.context)

    def _counts(self, obj):
        return (self.context.get("comment_counts") or {}).get(obj.id) or {}

    def get_comment_count(self, obj):
        return self._counts(obj).get("total", 0)

    def get_new_comment_count(self, obj):
        return self._counts(obj).get("new", 0)

    def validate_text(self, value):
        # A photo-only post is fine, so blank text is allowed here; the view
        # enforces "must have text or at least one photo". Normalise whitespace.
        return value.strip()


class UserListSerializer(serializers.ModelSerializer):
    """A person in the "find people to connect with" list, or a profile header.

    ``connection_status`` describes the *requesting* user's relationship to this
    person, so the UI can render the right button: ``"none"`` (Connect),
    ``"requested"`` (you asked — awaiting them), ``"incoming"`` (they asked —
    awaiting you), or ``"connected"`` (mutual). It's annotated onto the queryset
    in the view (one query, no N+1).
    """

    display_name = serializers.CharField(read_only=True)
    connection_status = serializers.CharField(read_only=True)
    avatar_thumb = serializers.SerializerMethodField()
    bio = serializers.CharField(read_only=True)
    # Whether the requesting user has blocked this person. Annotated only on the
    # profile-detail queryset; defaults to False elsewhere (e.g. the people
    # list, which doesn't surface block state).
    is_blocked = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = (
            "id",
            "display_name",
            "connection_status",
            "avatar_thumb",
            "bio",
            "is_blocked",
        )

    def get_is_blocked(self, obj):
        return bool(getattr(obj, "is_blocked", False))

    def get_avatar_thumb(self, obj):
        return absolute_media_url(obj.avatar_thumb, self.context.get("request"))


class ConnectionRequestSerializer(serializers.ModelSerializer):
    """An incoming connection request shown in the requestee's "Requests" inbox.

    ``id`` is the Connection row's id — the handle used to approve/reject it.
    ``requester`` is the person asking to connect with you.
    """

    requester = AuthorSerializer(read_only=True)

    class Meta:
        model = Connection
        fields = ("id", "requester", "created_at")


class CommentSerializer(serializers.ModelSerializer):
    """A node in the visible comment tree, with its visible replies nested under
    it.

    ``replies`` is read from ``_visible_children`` — the list the view's tree
    builder attached after pruning — **not** from the raw ``replies`` relation,
    so hidden branches never appear. The serializer is recursive: each reply is
    rendered with this same serializer.

    ``edited_at`` and ``deleted_at`` are both read-only and both **null until the
    thing they name happens** (issue #128), which is what lets a client render
    the "· edited" marker and the "comment deleted" tombstone off the payload
    alone. A deleted comment's ``text`` is genuinely blank in the database, so
    the tombstone isn't a client-side courtesy — there is nothing left to leak.
    The author is still named on a tombstone, matching a deleted message: the
    connection prune keys on it, and "someone deleted something here" without
    saying who reads worse than the truth in a thread you can already see.
    """

    author = AuthorSerializer(read_only=True)
    replies = serializers.SerializerMethodField()
    reactions = serializers.SerializerMethodField()

    class Meta:
        model = Comment
        fields = (
            "id",
            "author",
            "parent",
            "text",
            "created_at",
            "edited_at",
            "deleted_at",
            "replies",
            "reactions",
        )
        read_only_fields = ("edited_at", "deleted_at")

    def get_replies(self, obj):
        children = getattr(obj, "_visible_children", [])
        return CommentSerializer(
            children, many=True, context=self.context
        ).data

    def get_reactions(self, obj):
        return reactions_representation(obj, self.context)


class CommentCreateSerializer(serializers.ModelSerializer):
    """Create a comment or a reply.

    ``author`` and ``post`` are set in the view (from the session and the URL),
    never the body. ``parent`` is optional — omit it for a top-level comment,
    or give the id of the comment being replied to (the view checks it belongs
    to the same post).
    """

    text = serializers.CharField(max_length=POST_MAX_LENGTH)

    class Meta:
        model = Comment
        fields = ("id", "parent", "text", "created_at")
        read_only_fields = ("id", "created_at")

    def validate_text(self, value):
        stripped = value.strip()
        if not stripped:
            raise serializers.ValidationError("A comment can't be empty.")
        return stripped


class CommentEditSerializer(serializers.Serializer):
    """Edit your own comment's text (issue #128) — ``PATCH /comments/<pk>/``.

    Deliberately **not** ``CommentCreateSerializer`` with ``partial=True``, even
    though the text rules are identical and duplicated below. That serializer
    has a writable ``parent``, so a partial update through it would let a body
    field re-parent a comment into a different branch of the tree — moving what
    someone said under a reply they never answered. An edit is a statement about
    the text and nothing else, so text is the only field that exists here.

    ``text`` is required rather than optional: an edit that omits it isn't a
    no-op request, it's a malformed one, and the same reasoning as the message
    editor applies (see ``MessageDetailView``).
    """

    text = serializers.CharField(max_length=POST_MAX_LENGTH)

    def validate_text(self, value):
        stripped = value.strip()
        if not stripped:
            # A comment has no photo to fall back on (unlike a post), so
            # emptying one is a delete — and delete is its own endpoint, with
            # its own reply-preserving semantics.
            raise serializers.ValidationError(
                "A comment can't be empty — delete it instead."
            )
        return stripped


# Direct messages share the post/comment length cap — plenty for a chat message
# while still bounding what a single row can write to the database.
MESSAGE_MAX_LENGTH = POST_MAX_LENGTH

# A group chat's title, matching ``Conversation.title``'s column width. Named
# rather than repeated so the create path (which clipped to a literal 100) and
# the rename path (Phase 9b M6) can't drift about *what fits*.
#
# They still differ in what they do *at* the limit, and it's worth knowing which
# is which: **create truncates silently, rename rejects with a 400.** Create has
# behaved that way since Phase 6a, so it's left alone rather than tightened into
# a behaviour change on a shipped endpoint; both clients now cap the field at
# this length (M6 — they didn't before), which is what makes the truncation
# unreachable by anyone not hand-rolling a request. Rename is new, so it can
# afford to be strict, and a rename that stored something other than what you
# typed would be worse than an error.
CONVERSATION_TITLE_MAX_LENGTH = 100

# --- message attachments (Phase 9b M7) ---------------------------------------
# 🔒 These four constants are the *entire* server-side defence for chat photos,
# which is a deliberate design and not a gap. A message attachment is processed
# on the client (resized, EXIF-stripped, re-encoded) so the pipeline is unchanged
# the day the server is handed ciphertext instead — see ``MessageAttachment``.
# Size and count are the only limits that still mean something on bytes you
# cannot open, so they carry the whole load and are set tight.

# The phone uploads at MESSAGE_IMAGE_MAX_EDGE / JPEG q0.8, which lands a
# photographic image around 200–500 KB. 4 MB is far above anything that pipeline
# produces and far below anything that hurts the box — the gap absorbs an odd
# image (a huge flat-colour PNG-ish screenshot) without inviting one.
MESSAGE_ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024
# The thumbnail is a ~400px JPEG, tens of KB. Capped separately and much lower:
# a client that sent the full image twice would double every chat's storage and
# the bubble would download the big one on cellular.
MESSAGE_THUMBNAIL_MAX_BYTES = 512 * 1024
# One attachment per message. The model is a table so several is additive later,
# but the app sends a multi-photo pick as several messages — see messaging.md.
# The cap exists so an unbounded count can't be the way around the byte cap.
MESSAGE_ATTACHMENTS_MAX = 1
# Sanity bound on the client-declared dimensions. Not a security control (they're
# layout hints), just a floor/ceiling so a typo or a hostile client can't hand
# the bubble an aspect ratio that computes to a zero-height or mile-tall row.
MESSAGE_ATTACHMENT_MAX_EDGE = 10_000

# --- mentions (Phase 9b M8) ---------------------------------------------------
# How many people one message may name. Far above what anyone types by hand in a
# family-sized group, and low enough that a hostile client can't turn one send
# into a fan-out that overrides everybody's mute at once — which is the only way
# this list can do damage, since a mention's whole power is beating mute.
MESSAGE_MENTIONS_MAX = 20


def _human_bytes(count):
    """A byte cap as a person would say it, for a validation message they'll read.

    Formatted in KB below a megabyte rather than rounded to one: the thumbnail
    cap is 512 KB, and a naive megabyte format renders that "0 MB" — an error
    telling someone their file must be under nothing.
    """
    if count < 1024 * 1024:
        return f"{count // 1024} KB"
    return f"{count / (1024 * 1024):.0f} MB"


class MessageAttachmentSerializer(serializers.ModelSerializer):
    """One attachment on a message, as absolute URLs plus the client-declared
    dimensions so the bubble can reserve space before the image loads.

    ``kind`` is on the wire from day one even though ``image`` is its only value:
    it's what lets Phase 13's video clips arrive as data rather than as a client
    release, and a client written today that switches on ``kind`` keeps working.

    Field names are ``url``/``thumbnail`` rather than ``PostImageSerializer``'s
    ``image``/``thumbnail`` for the same reason — ``image`` would be the wrong
    word for a video's file, and renaming a shipped field later is the sort of
    break the phase's compatibility rule exists to avoid.
    """

    url = serializers.SerializerMethodField()
    thumbnail = serializers.SerializerMethodField()

    class Meta:
        model = MessageAttachment
        fields = ("id", "kind", "url", "thumbnail", "width", "height")

    def get_url(self, obj):
        return absolute_media_url(obj.file, self.context.get("request"))

    def get_thumbnail(self, obj):
        return absolute_media_url(obj.thumbnail, self.context.get("request"))


class MessageSerializer(serializers.ModelSerializer):
    """A single message in a conversation thread.

    ``sender`` is the embedded author slice (id + display name + avatar), so the
    thread can align/label each bubble. A soft-deleted message reports
    ``is_deleted: true`` with blank ``text`` — the client renders a "message
    deleted" placeholder in its place, keeping the thread's order intact.

    ``is_edited``/``edited_at`` (Phase 9b M1) let the bubble show an "Edited"
    marker. ``reactions`` (Phase 9b M2) is the aggregate the bubble's pill row
    renders. ``reply_to``/``thread_root_id``/``reply_count`` (Phase 9b M3) drive
    the collapsed quote and the focused thread view — and ``reply_to`` is a bare
    id, for the reason spelled out on its getter. All of them are *additive*
    fields: an older client that doesn't know about them simply ignores them,
    which is why the backend can ship ahead of either client.

    **``reactions`` is deliberately not pruned per viewer**, unlike a post's or a
    comment's — see the ``EVERYONE`` sentinel. It's the one place the two differ,
    and it's because a chat's active participants are already a clique.
    """

    sender = AuthorSerializer(read_only=True)
    is_deleted = serializers.BooleanField(read_only=True)
    is_edited = serializers.BooleanField(read_only=True)
    reactions = serializers.SerializerMethodField()
    reply_to = serializers.SerializerMethodField()
    reply_count = serializers.SerializerMethodField()
    attachments = serializers.SerializerMethodField()
    mentions = serializers.SerializerMethodField()

    class Meta:
        model = Message
        fields = (
            "id",
            "sender",
            "text",
            "is_deleted",
            "is_edited",
            "created_at",
            "edited_at",
            "reactions",
            "reply_to",
            "thread_root_id",
            "reply_count",
            "attachments",
            "mentions",
        )

    def get_reactions(self, obj):
        request = self.context.get("request")
        me_id = request.user.id if request and request.user.is_authenticated else None
        return summarise_reactions(obj.reactions.all(), EVERYONE, me_id)

    def get_reply_to(self, obj):
        """The message this one answers, as a **bare id** — no text, no author.

        🔒 This is the phase's load-bearing privacy rule for replies. Embedding
        the quoted body here would hand it to whoever can see the *reply*, which
        walks straight around ``visible_messages_for``: a member who was
        ``pending`` across a gap would read clipped-out history through someone
        else's quote of it. A client that wants the quoted body fetches that
        message through the interval-clipped endpoint like any other, so the same
        rule decides it — and under E2E the server couldn't supply the text here
        anyway, so this is the shape that survives.

        **The author doesn't ride along either**, which an earlier cut of M3 got
        wrong. It looked harmless — you're only being told who wrote a message
        you may already be looking at — but in a group it isn't: someone can
        join, post, and leave again entirely inside your interval gap, and
        ``participants`` only ever lists current members. A later reply quoting
        them would then hand you a name and an avatar for a person you were
        never in a chat with, which is the same existence leak the clipped
        ``reply_count`` below refuses to make, only with a face on it.

        Nothing is lost by dropping it. A client that resolved the quoted message
        has its ``sender`` already; a client that couldn't isn't entitled to the
        author any more than to the words. One rule, no per-viewer branch to get
        wrong: **if you can't see the message, you learn nothing about it but
        that your reply-mate answered something.**
        """
        if not obj.reply_to_id:
            return None
        # ``reply_to_id`` and not ``reply_to`` — deliberately no fetch of the
        # quoted row at all, so there's nothing here to leak by accident later.
        return {"id": obj.reply_to_id}

    def get_reply_count(self, obj):
        """How many replies hang off this message, when it's a thread root.

        Non-zero only on a root, which is exactly what the transcript needs to
        know: it decides which bubbles show a "3 replies" affordance opening the
        focused thread view.

        The list view annotates this (``_with_reply_counts``) so a page doesn't
        run a query per bubble — and, more importantly, so the count is over the
        *viewer's* visible messages. The fallback below is unclipped, which is
        safe only because it's reached by exactly two callers: the response to
        your own send (a brand-new message, so zero) and to your own edit (your
        message, inside a 15-minute window, in a thread you can still send to).
        **Don't reuse this serializer for a list without annotating** — an
        unclipped count would leak that replies exist inside someone's gap.
        """
        annotated = getattr(obj, "reply_count", None)
        if annotated is not None:
            return annotated
        return obj.thread_messages.count()

    def get_attachments(self, obj):
        """The photos on this message (Phase 9b M7) — empty list for a text one.

        **A tombstone carries none**, whatever is still on disk. Soft delete
        blanks the text, and a "message deleted" placeholder that still showed
        the photo would make delete a lie about the one thing people most want
        deleted. (The rows and files are reaped by the delete path itself; this
        is the render-side half of the same promise, so an attachment can't
        reappear through a serializer that forgot.)
        """
        if obj.is_deleted:
            return []
        return MessageAttachmentSerializer(
            obj.attachments.all(), many=True, context=self.context
        ).data

    def get_mentions(self, obj):
        """Who this message names, as **bare user ids** (Phase 9b M8).

        Ids and nothing else, for the same reason ``reply_to`` is a bare id: a
        name and an avatar attached here would be content the server supplied
        about a *person*, and the client can resolve an id against the
        participants payload it already has. Under E2E the client is the only
        side that can match an id to the ``@Ada`` in the text anyway, so this is
        the shape that survives.

        **Not pruned per viewer**, and that's considered rather than skipped: a
        mention id is inert on its own, and anyone reading this message can
        already read the ``@Ada`` in its text — the name was typed *into* the
        words. So there is nothing here that the message body doesn't already
        say, which is exactly the test the reply-quote rule applies.

        A tombstone reports none. Its text is gone, so a highlight would have
        nothing to highlight, and "who was named in a message that no longer
        exists" isn't a question a deleted message should still answer.
        """
        if obj.is_deleted:
            return []
        return [mention.user_id for mention in obj.mentions.all()]


class MessageCreateSerializer(serializers.ModelSerializer):
    """Create a message. ``sender`` and ``conversation`` are set in the view
    (from the session and the URL), never the body.

    **Editing reuses this serializer for validation** rather than defining a
    near-identical twin: an edit must be held to exactly the same rules as the
    original send (non-blank after stripping, within ``MESSAGE_MAX_LENGTH``), and
    two copies of those rules would eventually disagree. ``reply_to_id`` is
    simply absent on an edit — you can't re-target an existing message, which
    would rewrite a thread someone has already read.

    ``reply_to_id`` (Phase 9b M3) is resolved against ``visible_messages``, a
    queryset the **view** supplies in context: it's the sender's own
    interval-clipped set, so you can only reply to a message you can actually
    see, and an id you can't see is rejected identically to one that doesn't
    exist. Passing the queryset in rather than importing the clipping helper here
    keeps one implementation of the rule in ``views.py`` instead of a second copy
    that drifts.

    **Attachments (Phase 9b M7)** ride in as multipart parts alongside the text,
    the way a post's photos do — but *already processed*, because the phone does
    the resizing and stripping (see ``MessageAttachment``). Each one is three
    parts and a number pair: the image, its thumbnail, and its dimensions. They
    are **parallel lists**, validated to the same length, so raising
    ``MESSAGE_ATTACHMENTS_MAX`` above 1 is a constant change and not an API
    change — the client already sends the plural shape.

    A message must be **text, attachments, or both — never neither**, matching
    the rule posts have enforced since Phase 4. That's what makes ``text``
    optional here, which in turn is why ``validate`` and not ``validate_text``
    decides emptiness: only the whole payload knows whether a blank message is a
    photo or a mistake.
    """

    text = serializers.CharField(
        max_length=MESSAGE_MAX_LENGTH,
        required=False,
        allow_blank=True,
        default="",
    )
    reply_to_id = serializers.IntegerField(
        required=False, allow_null=True, write_only=True
    )
    mention_ids = serializers.ListField(
        child=serializers.IntegerField(),
        required=False,
        write_only=True,
        max_length=MESSAGE_MENTIONS_MAX,
    )
    attachments = serializers.ListField(
        child=serializers.FileField(),
        required=False,
        write_only=True,
        max_length=MESSAGE_ATTACHMENTS_MAX,
    )
    attachment_thumbnails = serializers.ListField(
        child=serializers.FileField(),
        required=False,
        write_only=True,
        max_length=MESSAGE_ATTACHMENTS_MAX,
    )
    # Client-declared, because nothing here opens the file. Bounded so a bad
    # value can't produce an unrenderable bubble; see ``MessageAttachment``.
    attachment_widths = serializers.ListField(
        child=serializers.IntegerField(
            min_value=1, max_value=MESSAGE_ATTACHMENT_MAX_EDGE
        ),
        required=False,
        write_only=True,
        max_length=MESSAGE_ATTACHMENTS_MAX,
    )
    attachment_heights = serializers.ListField(
        child=serializers.IntegerField(
            min_value=1, max_value=MESSAGE_ATTACHMENT_MAX_EDGE
        ),
        required=False,
        write_only=True,
        max_length=MESSAGE_ATTACHMENTS_MAX,
    )

    class Meta:
        model = Message
        fields = (
            "id",
            "text",
            "created_at",
            "reply_to_id",
            "mention_ids",
            "attachments",
            "attachment_thumbnails",
            "attachment_widths",
            "attachment_heights",
        )
        read_only_fields = ("id", "created_at")

    def validate_text(self, value):
        return value.strip()

    def validate_mention_ids(self, value):
        """🔒 Only people who are actually in the room may be named.

        The check is against ``mentionable_ids`` — the conversation's *active*
        participants, supplied by the view for the same reason
        ``visible_messages`` is: the membership rules live in ``views.py`` and a
        second copy here would drift from them.

        It matters because a mention is the one thing in messaging that beats
        mute. Accepting an arbitrary id would turn this field into a way to buzz
        someone's phone about a conversation they aren't part of — a stranger
        push, which is precisely what the clique invariant exists to make
        impossible. A pending member is excluded too: they can't read a line of
        the thread yet, so naming them would announce something the app would
        then refuse to show them.

        Duplicates are collapsed rather than rejected. Naming someone twice in
        one message is one mention of them, and it's the sort of thing a client
        does by accident with no user intent behind it worth erroring over.
        """
        if not value:
            return []
        mentionable = self.context.get("mentionable_ids")
        if mentionable is None:
            # A caller that didn't supply the participant set can't be allowed to
            # fall through to unchecked mentions — the same fail-loudly rule
            # ``reply_to_id`` follows, and for a closely related reason.
            raise serializers.ValidationError("Mentions aren't available here.")
        # Order-preserving dedupe: the ids are a client's reading of its own
        # composer, so keeping their order keeps the stored rows in the order the
        # names appear, which is the least surprising thing for anything that
        # later reads them back.
        seen = []
        for user_id in value:
            if user_id not in seen:
                seen.append(user_id)
        unknown = [user_id for user_id in seen if user_id not in mentionable]
        if unknown:
            raise serializers.ValidationError(
                "You can only mention people in this conversation."
            )
        return seen

    def validate_attachments(self, value):
        return self._check_sizes(value, MESSAGE_ATTACHMENT_MAX_BYTES, "photo")

    def validate_attachment_thumbnails(self, value):
        return self._check_sizes(value, MESSAGE_THUMBNAIL_MAX_BYTES, "thumbnail")

    def _check_sizes(self, files, cap, label):
        """🔒 The byte cap — one of the only two checks left once the bytes are
        opaque, so it's applied to every part rather than to their total: a total
        would let one enormous file through whenever the others were small.
        """
        for upload in files:
            if upload.size > cap:
                raise serializers.ValidationError(
                    f"Each {label} must be under {_human_bytes(cap)}."
                )
        return files

    def validate(self, attrs):
        """Cross-field rules: the lists line up, and the message isn't empty."""
        files = attrs.get("attachments") or []
        thumbs = attrs.get("attachment_thumbnails") or []
        widths = attrs.get("attachment_widths") or []
        heights = attrs.get("attachment_heights") or []
        if not (len(files) == len(thumbs) == len(widths) == len(heights)):
            # A mismatch means the client's parts got out of step, and guessing
            # which photo the spare dimension belongs to would silently store the
            # wrong aspect ratio. Refusing is the only honest answer.
            raise serializers.ValidationError(
                "Each attachment needs a thumbnail, a width and a height."
            )

        # ``has_attachments`` covers the *edit* path, which sends no files: a
        # photo message may legitimately be edited down to no caption at all,
        # while a text message may not be edited into nothing. The view knows
        # which it's looking at; this serializer doesn't fetch the row to find
        # out, because on create there's no row yet.
        has_attachments = bool(files) or self.context.get("has_attachments", False)
        if not attrs.get("text") and not has_attachments:
            raise serializers.ValidationError(
                {"text": "A message can't be empty."}
            )
        return attrs

    def validate_reply_to_id(self, value):
        if value is None:
            return None
        visible = self.context.get("visible_messages")
        if visible is None:
            # A caller that didn't supply the clipped queryset can't be allowed
            # to fall through to an unchecked reply — failing loudly here is the
            # difference between a wiring mistake and a quiet privacy hole.
            raise serializers.ValidationError("Replies aren't available here.")
        # Same 404-shaped answer whether the message is in another conversation,
        # inside the sender's interval gap, or simply not a real id: all three
        # are "you can't reply to that", and distinguishing them would turn this
        # field into an existence oracle for messages the sender was clipped out
        # of.
        if not visible.filter(pk=value).exists():
            raise serializers.ValidationError("That message isn't available.")
        return value


class ParticipantSerializer(serializers.Serializer):
    """One member of a group chat (or an implicit 1:1 side) for the
    ``participants`` list on a conversation — id, display name, avatar thumb,
    and their membership ``status`` (``"active"``/``"pending"``), enough to
    render the member list and explain a pending-lock panel.

    🔒 **Read receipts (Phase 9b M4) ride here, and are omitted rather than
    nulled when they mustn't be shared.** The conversation-detail view attaches
    ``_read_receipt`` to the rows whose read state may flow to this viewer (see
    ``attach_read_receipts``); everyone else's row simply doesn't carry the
    keys. That distinction is load-bearing and worth stating once:

    - **key absent** — "we're not telling you", because one of the two people
      involved has ``send_read_receipts`` off;
    - **key present, ``null``** — "they have never read this thread", which is
      real information the setting permits.

    Nulling both cases would collapse them and let a client mistake an opt-out
    for someone who never opened the chat.
    """

    id = serializers.IntegerField(source="user.id")
    display_name = serializers.CharField(source="user.display_name")
    avatar_thumb = serializers.ImageField(source="user.avatar_thumb", allow_null=True)
    status = serializers.CharField()

    def to_representation(self, instance):
        data = super().to_representation(instance)
        receipt = getattr(instance, "_read_receipt", None)
        if receipt is not None:
            data.update(receipt)
        return data


class ConversationSerializer(serializers.ModelSerializer):
    """A row in your conversation list, or the single-thread detail view.

    Covers both a 1:1 (``kind="direct"``) and a group chat (Phase 6a):
    ``other`` stays populated for a direct thread — the person you're talking
    to, resolved per-viewer in the view — for backward-compatible Phase 5
    rendering. ``title``/``group``/``participants`` describe a group chat (see
    ``chat_display_for``). ``my_status`` is your own membership state
    (``"active"``/``"pending"`` — a pending member sees a locked, read-only
    view driven by ``must_connect_with``). ``last_message``/``unread_count``
    are attached per-viewer by ``decorate_conversations`` (no N+1 across the
    list). ``can_send`` reports whether you may still post — set only on the
    detail view (the composer keys off it); history stays visible even when
    it's False.
    """

    group = serializers.SerializerMethodField()
    other = serializers.SerializerMethodField()
    participants = ParticipantSerializer(source="participant_rows", many=True, read_only=True)
    my_status = serializers.SerializerMethodField()
    must_connect_with = AuthorSerializer(source="must_connect", many=True, read_only=True)
    last_message = serializers.SerializerMethodField()
    unread_count = serializers.IntegerField(read_only=True)
    # Whether *you* have muted this thread's push notifications (issue #118) —
    # attached per-viewer by ``decorate_conversations``. Mute silences the buzz
    # only: ``unread_count`` still climbs and the badge still shows, so a muted
    # thread is quiet, not hidden.
    muted = serializers.BooleanField(read_only=True, default=False)
    # Whether you can still *send* in this thread (connected/active, not
    # blocked). Set only on the conversation-detail view; ``null`` in the
    # list, which doesn't need it. Renamed from Phase 5's ``can_message``.
    can_send = serializers.SerializerMethodField()

    class Meta:
        model = Conversation
        fields = (
            "id",
            "kind",
            "title",
            "group",
            "other",
            "participants",
            "my_status",
            "must_connect_with",
            "last_message",
            "unread_count",
            "muted",
            "can_send",
            "updated_at",
        )
        read_only_fields = ("id", "kind", "title", "updated_at")

    def get_other(self, obj):
        if obj.kind != Conversation.Kind.DIRECT:
            return None
        other = getattr(obj, "other", None)
        if other is None:
            return None
        return AuthorSerializer(other, context=self.context).data

    def get_group(self, obj):
        # The view (``decorate_conversations``) precomputes this via
        # ``chat_display_for`` and stashes it on the instance — this
        # serializer can't import from ``views`` (views already imports from
        # here), so it reads the result rather than calling the helper.
        return getattr(obj, "_group_display", None)

    def get_my_status(self, obj):
        return getattr(obj, "my_status", None)

    def get_can_send(self, obj):
        return getattr(obj, "_can_message", None)

    def get_last_message(self, obj):
        # The view attaches the latest message (or None) as ``_last_message`` to
        # avoid an N+1 across the list.
        message = getattr(obj, "_last_message", None)
        if message is None:
            return None
        return {
            "text": "" if message.is_deleted else message.text,
            "is_deleted": message.is_deleted,
            "sender_id": message.sender_id,
            "created_at": message.created_at,
            # How many photos it carries (Phase 9b M7) — a *count*, not the
            # photos, because this is a list preview and the row renders
            # "📷 Photo" from it. Deliberately a number and not a rendered
            # string: the phrasing is a client concern (it's localised text next
            # to an emoji), and a count is also the one fact about an attachment
            # that survives the server not being able to see it under E2E.
            "attachment_count": 0 if message.is_deleted else len(message.attachments.all()),
        }


class ConversationRenameSerializer(serializers.Serializer):
    """The one writable field on a conversation: a group chat's ``title``
    (Phase 9b M6).

    Deliberately its own tiny serializer rather than making
    ``ConversationSerializer`` writable. Almost every field there is a
    ``SerializerMethodField`` decorated per-viewer by the view, so a partial
    update through it would be a wide, mostly-read-only surface with one field
    that happens to stick — the sort of shape where a later addition becomes
    writable by accident. This one states exactly what a client may change.

    **Blank is allowed, and means "no name".** Clearing a title is a real thing
    to want: both clients fall back to a comma-joined list of the other members,
    which is a better name for an ad-hoc chat than a stale one. Whitespace is
    stripped so a "name" made of spaces can't render as an untitled chat with
    the fallback suppressed.
    """

    title = serializers.CharField(
        max_length=CONVERSATION_TITLE_MAX_LENGTH,
        allow_blank=True,
        trim_whitespace=True,
    )


# --- Groups (Phase 6) --------------------------------------------------------

GROUP_NAME_MAX_LENGTH = 100
GROUP_DESCRIPTION_MAX_LENGTH = 2000


class GroupSerializer(serializers.ModelSerializer):
    """Read + create + edit a group.

    Read fields give the group page + list what they need: ``avatar_url`` (full)
    and ``avatar_thumb`` (small, for the list), plus two **per-viewer** fields the
    view attaches — ``member_count`` (active members) and ``your_role``
    (``member``/``admin``, driving whether admin controls show). ``name`` and
    ``description`` are writable (create + PATCH); the avatar is uploaded
    separately as multipart and processed in the view (validated + downscaled +
    EXIF-stripped via ``api.imaging``), same as user avatars — never a raw file.
    """

    name = serializers.CharField(max_length=GROUP_NAME_MAX_LENGTH)
    description = serializers.CharField(
        max_length=GROUP_DESCRIPTION_MAX_LENGTH,
        required=False,
        allow_blank=True,
        default="",
    )
    avatar_url = serializers.SerializerMethodField()
    avatar_thumb = serializers.SerializerMethodField()
    member_count = serializers.SerializerMethodField()
    your_role = serializers.SerializerMethodField()

    class Meta:
        model = Group
        fields = (
            "id",
            "name",
            "description",
            "avatar_url",
            "avatar_thumb",
            "member_count",
            "your_role",
            "created_at",
        )
        read_only_fields = ("id", "created_at")

    def validate_name(self, value):
        stripped = value.strip()
        if not stripped:
            raise serializers.ValidationError("A group needs a name.")
        return stripped

    def validate_description(self, value):
        return value.strip()

    def get_avatar_url(self, obj):
        return absolute_media_url(obj.avatar, self.context.get("request"))

    def get_avatar_thumb(self, obj):
        return absolute_media_url(obj.avatar_thumb, self.context.get("request"))

    def get_member_count(self, obj):
        # Attached by the view (annotated in bulk, no N+1); falls back to the
        # model's shared count for safety if a caller forgot to annotate.
        count = getattr(obj, "member_count", None)
        if count is None:
            count = obj.active_member_count()
        return count

    def get_your_role(self, obj):
        return getattr(obj, "_your_role", None)


class GroupMemberSerializer(serializers.ModelSerializer):
    """One active member of a group: the person plus their role, so the members
    panel can badge admins and show admin-only controls."""

    user = AuthorSerializer(read_only=True)

    class Meta:
        model = GroupMembership
        fields = ("user", "role")


class GroupInviteSerializer(serializers.ModelSerializer):
    """A pending invite in your group-invites inbox.

    ``id`` is the membership row's id — the handle used to accept/reject.
    ``group`` is a minimal card of the group you've been invited to, and
    ``invited_by`` is who invited you (for the "X invited you to Y" line).
    """

    group = serializers.SerializerMethodField()
    invited_by = AuthorSerializer(read_only=True)

    class Meta:
        model = GroupMembership
        fields = ("id", "group", "invited_by", "created_at")

    def get_group(self, obj):
        return {
            "id": obj.group_id,
            "name": obj.group.name,
            "avatar_thumb": absolute_media_url(
                obj.group.avatar_thumb, self.context.get("request")
            ),
        }


class ReportCreateSerializer(serializers.ModelSerializer):
    """Flag a post, comment or message for the maintainer (Phase 7 takedown
    path; ``message`` added in Phase 9b M0).

    The body carries **exactly one** target — ``post``, ``comment`` or
    ``message`` (by id) — plus an optional free-text ``reason``. ``reporter`` and
    ``status`` are set by the view/model, never the body. The model's check
    constraint is the ultimate guardrail; validating here too gives a clean 400
    instead of a 500.

    ``message_text`` (the snapshot the maintainer reads) is **not a field here**
    in either direction: the view writes it from the message row, so a reporter
    can neither forge it nor read it back.
    """

    reason = serializers.CharField(
        max_length=REPORT_REASON_MAX_LENGTH,
        required=False,
        allow_blank=True,
        default="",
    )

    class Meta:
        model = Report
        fields = ("id", "post", "comment", "message", "reason", "created_at")
        read_only_fields = ("id", "created_at")

    def validate(self, attrs):
        targets = [attrs.get("post"), attrs.get("comment"), attrs.get("message")]
        if sum(1 for t in targets if t is not None) != 1:
            raise serializers.ValidationError(
                "Report exactly one of a post, a comment or a message."
            )
        return attrs


class NotificationSerializer(serializers.ModelSerializer):
    """One activity-centre notification, in a **push-ready** shape (Phase 8).

    The same payload the web dropdown renders is what the future iPhone/Android
    phases (9–10) turn into an OS notification + deep-link — so the mobile phases
    add only the *transport*, never a new API shape. The two pieces that make it
    reusable:

    - ``text`` — a human-readable line, phrased **server-side** per ``kind`` so
      the web app and a future push payload share one wording.
    - ``url`` — the in-app route to open. Post/reply/reaction kinds deep-link to
      the post **permalink** (``/p/<id>``); a comment reply/reaction adds
      ``?comment=<id>`` so the thread opens *at that comment* (even one 20 replies
      deep). Requests/invites point at their existing inboxes. ``target`` also
      carries ``{type, id}`` for clients that want to route by target directly.

    ``seen``/``addressed`` are the two read-state booleans (see ``Notification``).
    All four target FKs cascade-delete, so a notification never outlives its
    target — there are no dangling deep-links to filter out.
    """

    actor = AuthorSerializer(read_only=True)
    text = serializers.SerializerMethodField()
    target = serializers.SerializerMethodField()
    url = serializers.SerializerMethodField()
    seen = serializers.SerializerMethodField()
    addressed = serializers.SerializerMethodField()

    class Meta:
        model = Notification
        fields = (
            "id",
            "kind",
            "actor",
            "text",
            "target",
            "url",
            "created_at",
            "seen",
            "addressed",
        )

    def _actor_name(self, obj):
        return obj.actor.display_name if obj.actor else "Someone"

    def get_seen(self, obj):
        return obj.seen_at is not None

    def get_addressed(self, obj):
        return obj.addressed_at is not None

    def get_text(self, obj):
        name = self._actor_name(obj)
        K = Notification.Kind
        if obj.kind == K.POST_REPLY:
            return f"{name} replied to your post"
        if obj.kind == K.COMMENT_REPLY:
            return f"{name} replied to your comment"
        if obj.kind == K.REACTION:
            what = "post" if obj.post_id else "comment"
            return f"{name} reacted to your {what}"
        if obj.kind == K.CONNECTION_REQUEST:
            return f"{name} asked to connect"
        if obj.kind == K.CONNECTION_ACCEPTED:
            return f"{name} accepted your connection request"
        if obj.kind == K.GROUP_INVITE:
            group_name = obj.group.name if obj.group_id else "a group"
            return f"{name} invited you to {group_name}"
        # Event kinds (Phase 8b) — the actor is the organiser; name the event so
        # the line is meaningful in a push payload with no surrounding context.
        title = obj.event.title if obj.event_id else "an event"
        if obj.kind == K.EVENT_CREATED:
            return f"{name} planned {title}"
        if obj.kind == K.POLL_OPENED:
            return f"{name} opened a poll on {title}"
        if obj.kind == K.EVENT_SCHEDULED:
            return f"{name} set a date for {title}"
        if obj.kind == K.EVENT_UPDATED:
            return f"{name} updated {title}"
        if obj.kind == K.EVENT_CANCELLED:
            return f"{name} cancelled {title}"
        return f"{name} did something"

    def get_target(self, obj):
        """``{type, id}`` for the concrete thing the notification points at, or
        ``None``. Lets a client deep-link precisely (now or in a future app)."""
        if obj.post_id:
            return {"type": "post", "id": obj.post_id}
        if obj.comment_id:
            return {"type": "comment", "id": obj.comment_id}
        if obj.group_id:
            return {"type": "group", "id": obj.group_id}
        if obj.connection_id:
            return {"type": "connection", "id": obj.connection_id}
        if obj.event_id:
            return {"type": "event", "id": obj.event_id}
        return None

    def get_url(self, obj):
        K = Notification.Kind
        # Post permalink (/p/<id>), with ?comment=<id> when the notification is
        # about a specific comment so the thread opens right at it.
        if obj.kind == K.POST_REPLY and obj.post_id:
            return f"/p/{obj.post_id}"
        if obj.kind == K.COMMENT_REPLY and obj.comment_id:
            return f"/p/{obj.comment.post_id}?comment={obj.comment_id}"
        if obj.kind == K.REACTION:
            if obj.comment_id:
                return f"/p/{obj.comment.post_id}?comment={obj.comment_id}"
            if obj.post_id:
                return f"/p/{obj.post_id}"
        if obj.kind == K.CONNECTION_REQUEST:
            return "/requests"
        if obj.kind == K.CONNECTION_ACCEPTED and obj.actor_id:
            return f"/u/{obj.actor_id}"
        if obj.kind == K.GROUP_INVITE:
            return "/group-invites"
        # Event kinds deep-link to the event on its group page.
        if obj.event_id:
            return f"/g/{obj.event.group_id}/events/{obj.event_id}"
        return "/"


class NotificationPreferencesSerializer(serializers.Serializer):
    """The user's per-kind on/off map for the **mutable** kinds (Phase 8).

    Not a ``ModelSerializer``: preferences are stored one row per (user, kind)
    with *absence meaning enabled*, so the API presents them as a flat
    ``{kind: bool}`` map over exactly ``Notification.MUTABLE_KINDS`` (the
    request/invite kinds are always-on and never appear here). GET fills defaults
    for kinds with no row; PATCH accepts a partial map and upserts.
    """

    def to_representation(self, user):
        rows = {
            p.kind: p.enabled
            for p in user.notification_preferences.all()
        }
        return {
            kind: rows.get(kind, True)
            for kind in sorted(Notification.MUTABLE_KINDS)
        }

    def validate(self, attrs):
        # DRF hands raw fields in via the view; we validate the incoming map here.
        data = self.initial_data
        if not isinstance(data, dict):
            raise serializers.ValidationError("Expected a {kind: bool} object.")
        cleaned = {}
        for kind, enabled in data.items():
            if kind not in Notification.MUTABLE_KINDS:
                raise serializers.ValidationError(
                    {kind: "Not a mutable notification kind."}
                )
            if not isinstance(enabled, bool):
                raise serializers.ValidationError(
                    {kind: "Expected true or false."}
                )
            cleaned[kind] = enabled
        return cleaned


# ---------------------------------------------------------------------------
# Phase 8b — group events, polls, RSVPs
#
# The delicate rule (decision 2 in the phase doc): within an event a viewer can
# already see, **poll/RSVP counts are complete** (every participant in the
# audience — a shared coordination number must be honest) but **names are
# connection-gated** (you only see *who* voted / who's going among your own
# connections). This is the deliberate inverse of ``summarise_reactions`` above,
# where a non-connection's reaction doesn't even count. ``visible_ids`` here is
# the same set as ``visible_reactor_ids`` (you + your connections); the count is
# over *all* rows, the names filtered to that set.
# ---------------------------------------------------------------------------

EVENT_TITLE_MAX = 200
EVENT_DESCRIPTION_MAX = 5000
EVENT_TEXT_FIELD_MAX = 200  # location fields, poll option label/question, notes
MAX_GUESTS = 50  # a sane cap on a "+N" headcount


def _author_dict(user, request):
    return AuthorSerializer(user, context={"request": request}).data


def build_poll_results(poll, *, visible_ids, me_id, request):
    """A poll's options with **complete counts** + **connection-gated voter
    names** + the viewer's own selections.

    ``poll.options`` and each option's ``votes`` (with ``voter``) must be
    prefetched. ``count`` is every vote for the option; ``voters`` lists only
    those in ``visible_ids`` (you + your connections) — everyone else folds into
    the count as an anonymous +1. ``you_voted`` flags the viewer's own picks.
    """
    options = []
    your_votes = []
    for opt in poll.options.all():
        votes = list(opt.votes.all())
        voter_ids = {v.voter_id for v in votes}
        options.append({
            "id": opt.id,
            "label": opt.label,
            "date_value": opt.date_value,
            "time_value": opt.time_value,
            "text_value": opt.text_value,
            "order": opt.order,
            "count": len(votes),
            "voters": [
                _author_dict(v.voter, request)
                for v in votes if v.voter_id in visible_ids
            ],
            "you_voted": me_id in voter_ids,
        })
        if me_id in voter_ids:
            your_votes.append(opt.id)
    return options, your_votes


def serialize_poll(poll, *, visible_ids, me_id, request):
    """One poll as a dict: metadata + results (counts full, names gated)."""
    options, your_votes = build_poll_results(
        poll, visible_ids=visible_ids, me_id=me_id, request=request
    )
    # Total votes across every option (complete, not gated). The frontend gates
    # the "edit poll" affordance on this being 0 — a poll locks its wording the
    # moment the first vote lands (see the PATCH guard in the poll view).
    vote_count = sum(o["count"] for o in options)
    return {
        "id": poll.id,
        "event": poll.event_id,
        "dimension": poll.dimension,
        "question": poll.question,
        "allow_multiple": poll.allow_multiple,
        "status": poll.status,
        "closes_at": poll.closes_at,
        "created_at": poll.created_at,
        "options": options,
        "vote_count": vote_count,
        "your_votes": your_votes,
        # For a finalised custom poll, the option the organiser pinned (else null).
        "decided_option": poll.decided_option_id,
    }


def _dimension_states(event, open_builtin_polls):
    """Per built-in dimension (date/time/location): ``set`` if its field is
    populated, else ``polling`` if an open poll targets it, else ``unset``. The
    open poll id is surfaced regardless so a re-poll on an already-set dimension
    still shows a live tally on the chip."""
    populated = {
        "date": event.event_date is not None,
        "time": event.start_time is not None,
        "location": bool(event.location_name),
    }
    states = {}
    for dim in ("date", "time", "location"):
        poll = open_builtin_polls.get(dim)
        if populated[dim]:
            state = "set"
        elif poll is not None:
            state = "polling"
        else:
            state = "unset"
        states[dim] = {"state": state, "poll": poll.id if poll else None}
    return states


def build_rsvp_summary(event, *, visible_ids, me_id, request, named=True):
    """RSVP tallies for an event: **complete counts** + the viewer's own RSVP,
    and (when ``named``) **connection-gated** named lists per response.

    ``event.rsvps`` (with ``user``) must be prefetched. ``counts.guests`` is the
    summed "+N" headcount of the *going* responses only.
    """
    counts = {"going": 0, "maybe": 0, "declined": 0, "guests": 0}
    your = None
    lists = {"going": [], "maybe": [], "declined": []}
    for r in event.rsvps.all():
        counts[r.response] = counts.get(r.response, 0) + 1
        if r.response == EventRSVP.Response.GOING:
            counts["guests"] += max(r.guests or 0, 0)
        if r.user_id == me_id:
            your = {"response": r.response, "guests": r.guests, "note": r.note}
        if named and r.user_id in visible_ids:
            lists[r.response].append(_author_dict(r.user, request))
    out = {"counts": counts, "your_response": your}
    if named:
        out["going_list"] = lists["going"]
        out["maybe_list"] = lists["maybe"]
        out["declined_list"] = lists["declined"]
    return out


def serialize_event(event, *, viewer, visible_ids, request,
                    is_group_admin=False, detail=True):
    """The full event payload — scalar fields, dimension states, RSVP summary,
    and (in ``detail``) the polls.

    Built as a dict rather than a ``ModelSerializer`` because the gated
    aggregates (poll/RSVP names) don't map onto plain fields. Push-ready: a client
    (web now, a phone later) has everything to render the card and deep-link. The
    view must prefetch ``polls__options__votes__voter`` and ``rsvps__user``.
    """
    me_id = viewer.id
    can_manage = event.organiser_id == me_id
    polls = list(event.polls.all())
    open_builtin = {
        p.dimension: p
        for p in polls
        if p.status == Poll.Status.OPEN and p.dimension != Poll.Dimension.CUSTOM
    }
    data = {
        "id": event.id,
        "group": {"id": event.group_id, "name": event.group.name},
        "organiser": _author_dict(event.organiser, request),
        "title": event.title,
        "description": event.description,
        "event_date": event.event_date,
        "start_time": event.start_time,
        "end_time": event.end_time,
        "timezone": event.timezone,
        "location_name": event.location_name,
        "location_url": event.location_url,
        "location_note": event.location_note,
        "status": event.status,
        "is_past": event.is_past,
        "starts_at": event.starts_at,
        "dimensions": _dimension_states(event, open_builtin),
        "rsvp": build_rsvp_summary(
            event, visible_ids=visible_ids, me_id=me_id, request=request,
            named=detail,
        ),
        "can_manage": can_manage,
        "can_moderate": can_manage or is_group_admin,
        "created_at": event.created_at,
        "updated_at": event.updated_at,
        # Polls are included even in list/summary payloads — the dimension chips
        # need each poll's option tallies (a "polling" chip shows the live count)
        # and the custom-poll chips. Voter names ride along already connection-
        # gated. Only the heavier RSVP *named* lists are held back to ``detail``.
        "polls": [
            serialize_poll(p, visible_ids=visible_ids, me_id=me_id, request=request)
            for p in polls
        ],
    }
    return data


class EventWriteSerializer(serializers.ModelSerializer):
    """Validate an event **create** or **edit** body (organiser-authored fields).

    The scheduling dimensions (``event_date``/``start_time``/``location_name``)
    are deliberately **not** here — they're written only through ``finalise`` so
    the advisory-poll rule (decision 3) and the ``status`` recompute live in one
    place. This serializer covers the title, description, the auxiliary location
    detail (link/note), the timezone, and the optional end time.
    """

    title = serializers.CharField(max_length=EVENT_TITLE_MAX)
    description = serializers.CharField(
        max_length=EVENT_DESCRIPTION_MAX, required=False, allow_blank=True,
        default="",
    )

    class Meta:
        model = Event
        fields = (
            "title", "description", "location_url", "location_note",
            "timezone", "end_time",
        )

    def validate_title(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError("An event needs a title.")
        return value


class PollOptionWriteSerializer(serializers.Serializer):
    """One candidate option in a poll-create body. The typed value used depends
    on the poll's dimension (validated in the view, which knows the dimension):
    ``date_value`` for date, ``time_value`` for time, ``text_value`` for
    location/custom. ``label`` is optional — the view fills a sensible default
    from the value when it's blank."""

    label = serializers.CharField(
        max_length=EVENT_TEXT_FIELD_MAX, required=False, allow_blank=True,
        default="",
    )
    date_value = serializers.DateField(required=False, allow_null=True)
    time_value = serializers.TimeField(required=False, allow_null=True)
    text_value = serializers.CharField(
        max_length=EVENT_TEXT_FIELD_MAX, required=False, allow_blank=True,
        default="",
    )


class PollCreateSerializer(serializers.Serializer):
    """Validate a poll-create body: a dimension, an optional question (auto-phrased
    for built-ins when omitted), at least two options, and the poll knobs."""

    dimension = serializers.ChoiceField(choices=Poll.Dimension.choices)
    question = serializers.CharField(
        max_length=EVENT_TEXT_FIELD_MAX, required=False, allow_blank=True,
        default="",
    )
    allow_multiple = serializers.BooleanField(required=False, allow_null=True,
                                              default=None)
    closes_at = serializers.DateTimeField(required=False, allow_null=True)
    options = PollOptionWriteSerializer(many=True)

    def validate_options(self, value):
        if len(value) < 2:
            raise serializers.ValidationError(
                "A poll needs at least two options."
            )
        return value


class PollOptionEditSerializer(PollOptionWriteSerializer):
    """One option in a poll-**edit** body: the same typed value fields as a
    created option (``date_value`` / ``time_value`` / ``text_value`` / ``label``,
    interpreted per the poll's dimension), plus an **optional** ``id``. An entry
    with an ``id`` rewrites that existing option; without one it's a brand-new
    option. Reconciling the set (add/rewrite/drop) is only safe because the whole
    edit is gated on the poll having zero votes — no cast vote can be redefined
    or orphaned."""

    id = serializers.IntegerField(required=False)


class PollEditSerializer(serializers.Serializer):
    """Validate a poll-**edit** body (organiser fixing mistakes): a new
    ``question`` and/or rewritten ``options``. Both are optional so a caller can
    touch just one; the view rejects the edit entirely if the poll already has
    any votes."""

    question = serializers.CharField(max_length=EVENT_TEXT_FIELD_MAX, required=False)
    allow_multiple = serializers.BooleanField(required=False)
    options = PollOptionEditSerializer(many=True, required=False)

    def validate_question(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError("A poll needs a question.")
        return value


class RSVPWriteSerializer(serializers.Serializer):
    """Validate an RSVP upsert body: a response, optional +guests, optional note."""

    response = serializers.ChoiceField(choices=EventRSVP.Response.choices)
    guests = serializers.IntegerField(
        required=False, min_value=0, max_value=MAX_GUESTS, default=0
    )
    note = serializers.CharField(
        max_length=EVENT_TEXT_FIELD_MAX, required=False, allow_blank=True,
        default="",
    )


class FinaliseSerializer(serializers.Serializer):
    """Validate a ``finalise`` body — the organiser's *decision* on a dimension.

    ``value`` is a raw string interpreted per dimension in the view (a date, a
    time, or free text), and it need **not** match any poll option (decision 3 —
    the organiser can set a value no one voted for). For a ``custom`` poll,
    ``option_id`` pins a winning option instead. ``close_poll`` (default true)
    closes the related open poll as part of finalising.
    """

    dimension = serializers.ChoiceField(choices=Poll.Dimension.choices)
    value = serializers.CharField(required=False, allow_blank=True,
                                  allow_null=True, default="")
    option_id = serializers.IntegerField(required=False, allow_null=True)
    close_poll = serializers.BooleanField(required=False, default=True)


class DevicePushTokenSerializer(serializers.ModelSerializer):
    """Register/refresh one device's Expo push token (Phase 9, Milestone A)."""

    class Meta:
        model = DevicePushToken
        fields = ["expo_token", "platform"]
        # `expo_token` is globally unique on the model, which would normally make
        # DRF reject a re-registration as a duplicate. Registration is an upsert
        # by design (the same device re-registers on every launch, and may move
        # to a different user), so the uniqueness is resolved in the view's
        # update_or_create rather than as a validation error here.
        extra_kwargs = {"expo_token": {"validators": []}}


class DevicePushTokenDeleteSerializer(serializers.Serializer):
    """Unregister one device. Separate from the register serializer because
    DELETE identifies a device without re-stating its platform."""

    expo_token = serializers.CharField(max_length=255)
