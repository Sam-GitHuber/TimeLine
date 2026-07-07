from django.contrib import admin

from .models import (
    Block,
    Comment,
    Connection,
    Conversation,
    ConversationRead,
    Group,
    GroupMembership,
    Message,
    Post,
    PostImage,
)


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


class MessageInline(admin.TabularInline):
    """Show a conversation's messages inline so the maintainer can read/moderate
    a thread (and soft-delete an individual message) from the admin."""

    model = Message
    extra = 0
    fields = ("sender", "short_text", "deleted_at", "created_at")
    readonly_fields = ("sender", "short_text", "created_at")
    ordering = ("created_at", "id")

    @admin.display(description="text")
    def short_text(self, obj):
        if obj.is_deleted:
            return "(deleted)"
        return obj.text[:60] + ("…" if len(obj.text) > 60 else "")


@admin.register(Conversation)
class ConversationAdmin(admin.ModelAdmin):
    """Lets the maintainer read/moderate a 1:1 message thread from the admin.

    Messages are stored in plaintext (not E2E encrypted — see the phase doc's
    privacy notes), so they're readable here: a deliberate, disclosed property of
    the current design, not an oversight."""

    list_display = ("id", "user_a", "user_b", "updated_at", "created_at")
    list_select_related = ("user_a", "user_b")
    search_fields = ("user_a__email", "user_b__email")
    ordering = ("-updated_at",)
    inlines = (MessageInline,)


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
