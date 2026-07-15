"""
URL configuration for config project.

The `urlpatterns` list routes URLs to views. For more information please see:
    https://docs.djangoproject.com/en/5.1/topics/http/urls/
Examples:
Function views
    1. Add an import:  from my_app import views
    2. Add a URL to urlpatterns:  path('', views.home, name='home')
Class-based views
    1. Add an import:  from other_app.views import Home
    2. Add a URL to urlpatterns:  path('', Home.as_view(), name='home')
Including another URLconf
    1. Import the include() function: from django.urls import include, path
    2. Add a URL to urlpatterns:  path('blog/', include('blog.urls'))
"""

from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import include, path

from accounts.views import (
    InactiveRegisterView,
    ResendVerificationView,
    ThrottledLoginView,
    ThrottledPasswordChangeView,
    VerifyEmailCodeView,
    csrf,
)

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/", include("api.urls")),
    # Rate-limited overrides of two dj-rest-auth endpoints. These must come
    # BEFORE the include below — Django resolves URLs top-down and stops at the
    # first match, so our throttled views win over the library's defaults.
    path(
        "api/auth/login/",
        ThrottledLoginView.as_view(),
        name="rest_login",
    ),
    path(
        "api/auth/password/change/",
        ThrottledPasswordChangeView.as_view(),
        name="rest_password_change",
    ),
    # Auth API (dj-rest-auth): logout/, user/, password/reset*, token/*.
    path("api/auth/", include("dj_rest_auth.urls")),
    # Registration is our inactive-by-default view, not dj-rest-auth's default.
    path(
        "api/auth/registration/",
        InactiveRegisterView.as_view(),
        name="rest_register",
    ),
    # Email verification (issue #73): redeem the 6-digit code, and resend it.
    # Our own code-based flow, not dj-rest-auth's link/key endpoints — see
    # docs/reference/accounts.md for why.
    path(
        "api/auth/verify-email/",
        VerifyEmailCodeView.as_view(),
        name="verify_email",
    ),
    path(
        "api/auth/resend-verification/",
        ResendVerificationView.as_view(),
        name="resend_verification",
    ),
    # Lets the SPA obtain a CSRF cookie on load.
    path("api/auth/csrf/", csrf, name="csrf"),
]

# Serve user-uploaded media in development only. In production a real web
# server / object storage handles this (Phase 7); Django's static() helper is a
# no-op unless DEBUG is on, so this is safe to leave here.
if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
