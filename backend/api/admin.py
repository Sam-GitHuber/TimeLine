from django.contrib import admin

from .models import (
    Block,
    Comment,
    Connection,
    Conversation,
    ConversationRead,
    Group,
    GroupMembership,
    Notification,
    Participant,
    Post,
    PostImage,
    Report,
)

# NOTE: ``Message`` is deliberately **not** imported or registered here. There is
# no admin route to message text except a ``Report``'s snapshot — see
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
    fields = ("target", "reporter", "reason", "message_text", "status", "created_at")
    readonly_fields = ("target", "reporter", "reason", "message_text", "created_at")

    def has_add_permission(self, request):
        return False

    @admin.display(description="target")
    def target(self, obj):
        return obj.target_label()

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
