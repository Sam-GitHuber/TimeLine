from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin
from django.utils.translation import gettext_lazy as _

from .models import User


@admin.register(User)
class UserAdmin(DjangoUserAdmin):
    """Admin for the custom (email-login, no username) user.

    Based on Django's built-in UserAdmin but with every ``username`` reference
    swapped for ``email``. This is also the maintainer's approval console:
    new sign-ups arrive with ``is_active=False`` and cannot log in until the
    "Active" box is ticked here (see the "pending" filter/column below).
    """

    # Approving a sign-up is a one-toggle action: tick "Active". Surfaced in the
    # list so pending accounts are easy to spot and approve in bulk.
    list_display = ("email", "first_name", "last_name", "is_active", "is_staff")
    list_filter = ("is_active", "is_staff", "is_superuser", "groups")
    search_fields = ("email", "first_name", "last_name")
    ordering = ("email",)
    actions = ("approve_users",)

    fieldsets = (
        (None, {"fields": ("email", "password")}),
        (_("Personal info"), {"fields": ("first_name", "last_name")}),
        (
            _("Permissions"),
            {
                "fields": (
                    "is_active",
                    "is_staff",
                    "is_superuser",
                    "groups",
                    "user_permissions",
                ),
            },
        ),
        (_("Important dates"), {"fields": ("last_login", "date_joined")}),
    )
    # Fields shown on the "add user" admin page.
    add_fieldsets = (
        (
            None,
            {
                "classes": ("wide",),
                "fields": ("email", "password1", "password2"),
            },
        ),
    )

    @admin.action(description="Approve selected sign-ups (mark active)")
    def approve_users(self, request, queryset):
        updated = queryset.update(is_active=True)
        self.message_user(request, f"Approved {updated} account(s).")
