from django.contrib import admin

from .models import Comment, Connection, Post, PostImage


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
