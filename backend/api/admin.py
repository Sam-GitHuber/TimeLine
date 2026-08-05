import base64

from django.contrib import admin
from django.utils.html import format_html_join

from .models import (
    Block,
    Comment,
    Connection,
    Conversation,
    ConversationRead,
    EventPhoto,
    Group,
    GroupMembership,
    Notification,
    Participant,
    Post,
    PostImage,
    Report,
)
from .serializers import MESSAGE_THUMBNAIL_MAX_BYTES
from .views import delete_files_on_commit

# NOTE: ``Message`` is deliberately **not** imported or registered here, and
# neither is ``MessageAttachment`` — a browsable list of chat photos is the same
# window M0 closed, with pictures in it. There is no admin route to message
# content except a ``Report``'s snapshot (text) and the thumbnails of the exact
# message that was reported (``ReportAdmin.message_photos``) — see
# ``ConversationAdmin``. Don't add one.


class PostImageInline(admin.TabularInline):
    """Show a post's photos on the post admin page so the maintainer can
    moderate/delete individual images (they're read-only here — uploads always
    go through the validated API path, never the admin)."""

    model = PostImage
    extra = 0
    fields = ("image", "thumbnail", "width", "height", "created_at")
    readonly_fields = fields
    can_delete = True


@admin.register(Post)
class PostAdmin(admin.ModelAdmin):
    """Lets the maintainer read/moderate/delete posts from the admin."""

    list_display = ("id", "author", "short_text", "image_count", "created_at")
    list_select_related = ("author",)
    inlines = (PostImageInline,)
    search_fields = (
        "text",
        "author__email",
        "author__first_name",
        "author__last_name",
    )
    list_filter = ("created_at",)
    ordering = ("-created_at",)

    @admin.display(description="text")
    def short_text(self, obj):
        return obj.text[:60] + ("…" if len(obj.text) > 60 else "")

    @admin.display(description="photos")
    def image_count(self, obj):
        return obj.images.count()


@admin.register(Connection)
class ConnectionAdmin(admin.ModelAdmin):
    list_display = ("id", "requester", "requestee", "status", "created_at")
    list_select_related = ("requester", "requestee")
    list_filter = ("status",)
    search_fields = ("requester__email", "requestee__email")
    ordering = ("-created_at",)


@admin.register(Comment)
class CommentAdmin(admin.ModelAdmin):
    """Lets the maintainer read/moderate/delete comments from the admin."""

    list_display = ("id", "author", "post", "parent", "short_text", "created_at")
    list_select_related = ("author", "post", "parent")
    search_fields = ("text", "author__email")
    list_filter = ("created_at",)
    ordering = ("-created_at",)

    @admin.display(description="text")
    def short_text(self, obj):
        return obj.text[:60] + ("…" if len(obj.text) > 60 else "")


class ParticipantInline(admin.TabularInline):
    """A thread's membership — the *metadata* half of what the removed
    ``MessageInline`` used to show, and the half that's actually useful for
    support: status (``active``/``pending``), who invited whom, whether they
    left, whether they've muted it. Read-only; membership is driven by the
    clique state machine in ``views.py``, never edited by hand."""

    model = Participant
    extra = 0
    fields = ("user", "status", "invited_by", "left_at", "muted_at", "created_at")
    readonly_fields = fields
    can_delete = False

    def has_add_permission(self, request, obj):
        return False


@admin.register(Conversation)
class ConversationAdmin(admin.ModelAdmin):
    """Conversation **metadata only** — who's in a thread and when it was
    active. Deliberately no message text (Phase 9b M0).

    There used to be a ``MessageInline`` here that rendered every message in a
    thread, and the docstring called that a disclosed design property. It's gone,
    and it must not come back. Being *able* to browse a private conversation is
    not a feature: the realistic failure mode isn't an attacker, it's a bored
    maintainer reading a thread they have no business reading. Nothing in
    operating the site needs it.

    What's kept, because it answers real support questions ("why can't Dad see
    this chat?") while revealing no content: the participants, statuses,
    timestamps and kind. ``Participant`` rows are the useful part — they carry
    the clique state machine's status/``left_at``, which is what support
    questions are actually about.

    **The one legitimate reason to read a message is an abuse report**, so that's
    the only route: a reporter attaches the specific message, ``Report`` stores
    its own text snapshot (see ``Report`` in ``models.py``), and the maintainer
    reads *that* in ``ReportAdmin``. Content access is scoped to what someone
    deliberately showed you.

    This narrows **who looks**, not what's stored — messages are still plaintext
    rows in Postgres, so anyone with a shell on the box can still read them. Only
    E2E encryption fixes that; see ``docs/reference/messaging.md``.
    """

    list_display = (
        "id",
        "kind",
        "title",
        "participant_names",
        "group",
        "updated_at",
        "created_at",
    )
    list_select_related = ("group", "user_a", "user_b")
    list_filter = ("kind",)
    search_fields = (
        "user_a__email",
        "user_b__email",
        "participants__user__email",
        "title",
    )
    ordering = ("-updated_at",)
    inlines = (ParticipantInline,)

    def get_queryset(self, request):
        # Prefetch so the participants column is one extra query for the page,
        # not one per row.
        return (
            super()
            .get_queryset(request)
            .prefetch_related("participants__user")
        )

    @admin.display(description="participants")
    def participant_names(self, obj):
        """Who's in the thread — the metadata that makes a support question
        answerable. Falls back to the legacy 1:1 columns for a pre-Phase-6a
        thread that never got ``Participant`` rows."""
        names = [str(p.user) for p in obj.participants.all() if p.left_at is None]
        if not names and obj.user_a_id:
            names = [str(u) for u in (obj.user_a, obj.user_b) if u]
        return ", ".join(names) or "—"


@admin.register(Block)
class BlockAdmin(admin.ModelAdmin):
    list_display = ("id", "blocker", "blocked", "created_at")
    list_select_related = ("blocker", "blocked")
    search_fields = ("blocker__email", "blocked__email")
    ordering = ("-created_at",)


admin.site.register(ConversationRead)


class GroupMembershipInline(admin.TabularInline):
    """Show a group's members inline so the maintainer can see/moderate
    membership (roles, invited vs active) from the group admin page."""

    model = GroupMembership
    extra = 0
    fields = ("user", "role", "status", "invited_by", "created_at")
    readonly_fields = ("created_at",)
    autocomplete_fields = ("user", "invited_by")


@admin.register(Group)
class GroupAdmin(admin.ModelAdmin):
    """Lets the maintainer read/moderate/delete groups from the admin."""

    list_display = ("id", "name", "creator", "member_count", "created_at")
    list_select_related = ("creator",)
    search_fields = ("name", "creator__email")
    ordering = ("name",)
    inlines = (GroupMembershipInline,)

    @admin.display(description="members")
    def member_count(self, obj):
        return obj.active_member_count()


@admin.register(GroupMembership)
class GroupMembershipAdmin(admin.ModelAdmin):
    list_display = ("id", "group", "user", "role", "status", "created_at")
    list_select_related = ("group", "user")
    list_filter = ("role", "status")
    search_fields = ("group__name", "user__email")
    ordering = ("-created_at",)


@admin.register(EventPhoto)
class EventPhotoAdmin(admin.ModelAdmin):
    """Every photo in every event album — the maintainer's takedown lever for
    the one content type nobody in the app can see all of (Phase 8b).

    **Why this had to exist.** An event's album prunes per viewer on the
    *uploader*, and that prune is deliberately **not** widened for the group's
    admins: an organiser or group admin can remove only what they can see, like
    everyone else, because widening it would make the album the first place in
    TimeLine that shows you content from someone you never connected with. The
    consequence is that a photo whose uploader is connected to nobody with
    moderation powers has no in-app route to removal at all. That's fine — the
    same is already true of a post from someone you aren't connected to — but
    only because the maintainer's route reaches everything, and until this class
    existed it didn't reach here. Do **not** answer this by loosening the query
    instead; the decision is recorded in ``docs/reference/events.md``.

    Read-only, and no add form. Uploads always go through the validated API
    pipeline (``process_image`` strips EXIF/GPS and re-encodes), never the
    admin, so the only verb this page needs is delete. The FKs are readonly for
    ReportAdmin's reason too: an editable one renders a ``<select>`` of every
    row in the target table.
    """

    list_display = ("id", "event", "uploader", "width", "height", "created_at")
    list_select_related = ("event", "uploader")
    list_filter = ("created_at",)
    search_fields = (
        "event__title",
        "uploader__email",
        "uploader__first_name",
        "uploader__last_name",
    )
    ordering = ("-created_at",)
    fields = ("event", "uploader", "image", "thumbnail", "width", "height",
              "created_at")
    readonly_fields = fields

    def has_add_permission(self, request):
        return False

    # A takedown that leaves the JPEG on disk isn't a takedown, and a database
    # delete never touches storage — so both delete paths gather the files first
    # and sweep them, exactly as every API path that destroys an album does.
    # ``delete_model`` runs inside the admin's transaction, so the sweep waits
    # for the commit; the bulk action may not, in which case the callback fires
    # inline — after the rows are already gone, which is the safe order either
    # way (see ``delete_files_on_commit``).
    def delete_model(self, request, obj):
        files = [obj.image, obj.thumbnail]
        super().delete_model(request, obj)
        delete_files_on_commit(files)

    def delete_queryset(self, request, queryset):
        files = [f for photo in queryset for f in (photo.image, photo.thumbnail)]
        super().delete_queryset(request, queryset)
        delete_files_on_commit(files)


@admin.register(Report)
class ReportAdmin(admin.ModelAdmin):
    """The maintainer's moderation queue (Phase 7 takedown path).

    Filter to ``open`` reports, open the flagged post/comment (both are
    moderatable in their own admin), delete the content if warranted, then set
    the report's status to ``resolved``/``dismissed`` here to clear the queue.

    **For a reported message this page is the only place its text appears**
    (Phase 9b M0 removed the conversation message inline). It's the snapshot
    taken at report time, not a live read of the row — so a sender soft-deleting
    the message afterwards doesn't empty the report, and nothing here can be used
    to walk into the rest of the thread. There's no ``Message`` admin to click
    through to, by design: acting on a message report means acting on the *person*
    (block/deactivate) or deleting the message via the API as a participant.

    The snapshot is only on the detail page, never the changelist — the queue
    shouldn't put private text on screen while you're triaging statuses.

    **Triage-only: no add form, and ``status`` is the only editable field.** That
    isn't tidiness, it's the fix for a hole this class walked straight into. A
    report's ``message`` is a ForeignKey, so leaving it editable makes Django
    render a ``<select>`` of **every message in the database**, each labelled by
    ``Message.__str__`` — which is a 40-character preview of the text. That is
    strictly worse than the ``MessageInline`` we removed: one thread became every
    thread. The targets are therefore shown through ``target`` (a bare
    ``"message #12"``), and the reported text appears exactly once per page, as
    the snapshot. Nobody hand-writes a report anyway — members raise them through
    the API.

    The same trap applies to any FK added here later. If you add one, make it
    readonly and render it by id.
    """

    list_display = (
        "id",
        "status",
        "reporter",
        "target",
        "short_reason",
        "created_at",
    )
    list_select_related = ("reporter", "post", "comment", "message")
    list_filter = ("status", "created_at")
    # Deliberately not ``message_text``: searching it would turn the queue into a
    # keyword search over reported private messages.
    search_fields = ("reason", "reporter__email")
    ordering = ("-created_at",)
    list_editable = ("status",)
    # No raw ``post``/``comment``/``message`` FKs on the form — see the docstring.
    fields = (
        "target",
        "reporter",
        "reason",
        "message_text",
        "message_photos",
        "status",
        "created_at",
    )
    readonly_fields = (
        "target",
        "reporter",
        "reason",
        "message_text",
        "message_photos",
        "created_at",
    )

    def has_add_permission(self, request):
        return False

    @admin.display(description="target")
    def target(self, obj):
        return obj.target_label()

    @admin.display(description="reported photos")
    def message_photos(self, obj):
        """Thumbnails of the photos on a reported message (Phase 9b M7).

        **Why this exists.** M0's rule is that a report is the *only* window onto
        a private message, and M7 made a message able to be nothing but a photo.
        Without this, reporting an abusive image produced a queue entry with an
        empty snapshot and no way to see what was flagged — which would have
        meant photo abuse was the one thing the moderation path couldn't act on.
        Same window, same justification as ``message_text``: the reporter chose
        to show the maintainer this specific message.

        **Two differences from the text snapshot, both deliberate.** This is a
        *live* read of the message's attachments, not a copy taken at report
        time — we don't duplicate someone's photo into a second place on disk to
        hold as evidence. So if the sender deletes the message the photos are
        genuinely gone (M7 hard-deletes attachment files on delete) and this goes
        empty, where ``message_text`` would still hold its snapshot. That's the
        honest trade: "deleted" meaning the picture is really gone is worth more
        than a moderation queue that keeps its own copy of it.

        Thumbnails only, at thumbnail size. Enough to judge a report, and it
        avoids putting a full-size private photo on screen while triaging.

        🔒 **The bytes are inlined as ``data:`` URIs, not linked from
        ``/media/``, and that is not a style choice.** In production Caddy
        ``forward_auth``s every ``/media/*`` request to ``/api/media-auth/``,
        which runs on DRF's default authentication — the **JWT cookie**. The
        admin authenticates with Django's *session* cookie, which that endpoint
        does not accept, so an ``<img src="/media/…">`` here 401s and the
        moderation queue shows broken images unless the maintainer happens to
        also be signed into the app in the same browser. Reading the file
        server-side sidesteps the question: nothing is fetched, so nothing has
        to be authorised.

        It's also the safer rendering. A chat attachment is never decoded by us
        (see ``MessageAttachment``), so its bytes are unverified — and a
        ``data:image/jpeg`` inside an ``<img>`` has no navigable URL and cannot
        execute whatever they turn out to be. A blob that isn't an image simply
        fails to draw.
        """
        message = obj.message
        if message is None:
            return ""
        rows = []
        for attachment in message.attachments.all():
            if not attachment.thumbnail:
                continue
            try:
                with attachment.thumbnail.open("rb") as handle:
                    # Bounded by the same cap the upload was accepted under, so a
                    # restored or hand-placed file can't inline megabytes into an
                    # admin page. Read one byte past it to tell "at the cap" from
                    # "over it" without holding the whole thing twice.
                    raw = handle.read(MESSAGE_THUMBNAIL_MAX_BYTES + 1)
            except (FileNotFoundError, OSError):
                # The row outliving its file is a restore mismatch, not something
                # to 500 the moderation queue over — show the rest.
                continue
            if len(raw) > MESSAGE_THUMBNAIL_MAX_BYTES:
                continue
            encoded = base64.b64encode(raw).decode("ascii")
            rows.append((f"data:image/jpeg;base64,{encoded}",))
        if not rows:
            return ""
        return format_html_join(
            " ",
            '<img src="{}" style="max-height:160px;border-radius:6px" />',
            rows,
        )

    @admin.display(description="reason")
    def short_reason(self, obj):
        return obj.reason[:60] + ("…" if len(obj.reason) > 60 else "")


@admin.register(Notification)
class NotificationAdmin(admin.ModelAdmin):
    """Read-only-ish view of the activity centre (Phase 8) for debugging — the
    maintainer never hand-writes notifications; they're generated by the app."""

    list_display = ("id", "recipient", "actor", "kind", "state", "created_at")
    list_select_related = ("recipient", "actor")
    list_filter = ("kind", "created_at")
    search_fields = ("recipient__email", "actor__email")
    ordering = ("-created_at",)

    @admin.display(description="state")
    def state(self, obj):
        if obj.addressed_at:
            return "addressed"
        return "seen" if obj.seen_at else "unread"
