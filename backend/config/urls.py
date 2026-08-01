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

from dj_rest_auth.views import LogoutView, UserDetailsView
from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import include, path
from rest_framework_simplejwt.views import TokenBlacklistView

from accounts.views import (
    InactiveRegisterView,
    MobileLoginView,
    MobileTokenRefreshView,
    PasswordResetConfirmView,
    PasswordResetRequestView,
    ResendVerificationView,
    ThrottledLoginView,
    ThrottledPasswordChangeView,
    VerifyEmailCodeView,
    csrf,
)

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/", include("api.urls")),
    # dj-rest-auth's endpoints are registered ONE BY ONE below rather than with
    # `include("dj_rest_auth.urls")`. That include is not safe to override:
    # every route in it is an `re_path(r"login/?$", ...)` — note the OPTIONAL
    # trailing slash — so a `path()` above it only ever shadows the *slashed*
    # spelling. `/api/auth/login` (no slash) fell straight through to the
    # library's own view, which declares no throttle classes; because
    # DEFAULT_THROTTLE_CLASSES is deliberately unset (see settings.py), that
    # means no rate limit at all rather than a different one. The login limit
    # the settings comment calls "the crux" of the brute-force defence could
    # therefore be skipped by deleting one character, on a fully working login
    # that still set the JWT cookies. The same held for password/change, and
    # the include also left dj-rest-auth's link-based password/reset pair live
    # even though we ship our own code-based flow (see below) — where its
    # url generator reversed a name we'd rebound, making it 500 for real
    # accounts and 200 for unknown ones: an account-existence oracle.
    #
    # Listing routes explicitly is what stops that recurring: anything not
    # named here is not routed, and `path()` matches the trailing slash
    # exactly, so there is no second spelling to slip through.
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
    # The rest of dj-rest-auth, unmodified: logout/ and user/, which are the
    # only two the web app calls. Its token/verify + token/refresh pair is
    # deliberately NOT registered — no client calls either (the web session is
    # a 1-day cookie and simply re-logs in), and "mounted but uncalled" is
    # precisely the state that turned the password/reset pair into an
    # account-existence oracle. Four lines to add back if a client ever needs
    # them; until then they're anonymous surface earning nothing.
    path("api/auth/logout/", LogoutView.as_view(), name="rest_logout"),
    path("api/auth/user/", UserDetailsView.as_view(), name="rest_user_details"),
    # Native-app auth (Phase 9). Deliberately separate from the web endpoints
    # above: these return both tokens in the response body and set no cookies,
    # because JWT_AUTH_HTTPONLY (the web app's XSS mitigation) blanks the refresh
    # token out of the standard login response. See MobileLoginView's docstring
    # and docs/reference/accounts.md.
    path(
        "api/auth/mobile/login/",
        MobileLoginView.as_view(),
        name="mobile_login",
    ),
    # Refresh rotates (SIMPLE_JWT.ROTATE_REFRESH_TOKENS) and re-issues at the
    # app's long lifetime — but only for tokens carrying the `client: "mobile"`
    # claim, so a short-lived web refresh cookie can't be POSTed here to upgrade
    # itself. See accounts/tokens.py.
    path(
        "api/auth/mobile/refresh/",
        MobileTokenRefreshView.as_view(),
        name="mobile_token_refresh",
    ),
    # Logout is simplejwt's stock view: it takes a *token*, not credentials, so
    # there are no verification / approval / throttle checks to inherit. It
    # blacklists the refresh token server-side, which matters because deleting it
    # from the device alone wouldn't stop a copy lifted from a backup.
    path(
        "api/auth/mobile/logout/",
        TokenBlacklistView.as_view(),
        name="mobile_logout",
    ),
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
    # Forgotten-password reset (issue #38): our own 6-digit-code flow, mirroring
    # verify-email above. dj-rest-auth's link/token endpoints are no longer
    # routed at all (see the note at the top of this list), so this is the only
    # reset path that exists. The hyphenated spelling is kept for the clients
    # that already call it. See accounts.md for why a code over a link.
    path(
        "api/auth/password-reset/",
        PasswordResetRequestView.as_view(),
        name="password_reset_request",
    ),
    path(
        "api/auth/password-reset/confirm/",
        PasswordResetConfirmView.as_view(),
        # NOT named `password_reset_confirm`: that is the name dj-rest-auth and
        # allauth reverse with (uid, key) arguments, and our zero-argument path
        # squatting on it is what made their reset view 500 for real accounts.
        # Dropping their routes defused it; the distinct name means re-adding an
        # allauth include later can't re-arm it.
        name="password_reset_code_confirm",
    ),
    # Lets the SPA obtain a CSRF cookie on load.
    path("api/auth/csrf/", csrf, name="csrf"),
]

# Serve user-uploaded media in development only. In production a real web
# server / object storage handles this (Phase 7); Django's static() helper is a
# no-op unless DEBUG is on, so this is safe to leave here.
if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
