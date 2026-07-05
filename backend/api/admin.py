from django.contrib import admin

from .models import Comment, Connection, Post


@admin.register(Post)
class PostAdmin(admin.ModelAdmin):
    """Lets the maintainer read/moderate/delete posts from the admin."""

    list_display = ("id", "author", "short_text", "created_at")
    list_select_related = ("author",)
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
