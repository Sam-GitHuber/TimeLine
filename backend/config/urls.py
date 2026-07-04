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

from django.contrib import admin
from django.urls import include, path

from accounts.views import InactiveRegisterView, csrf

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/", include("api.urls")),
    # Auth API (dj-rest-auth): login/, logout/, user/, password/*, token/*.
    path("api/auth/", include("dj_rest_auth.urls")),
    # Registration is our inactive-by-default view, not dj-rest-auth's default.
    path(
        "api/auth/registration/",
        InactiveRegisterView.as_view(),
        name="rest_register",
    ),
    # Lets the SPA obtain a CSRF cookie on load.
    path("api/auth/csrf/", csrf, name="csrf"),
]
