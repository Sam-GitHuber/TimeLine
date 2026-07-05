from django.urls import path

from . import views

urlpatterns = [
    path("hello", views.hello, name="hello"),
    # Timeline
    path("feed/", views.FeedView.as_view(), name="feed"),
    path("posts/", views.PostCreateView.as_view(), name="post-create"),
    path(
        "posts/<int:pk>/comments/",
        views.PostCommentsView.as_view(),
        name="post-comments",
    ),
    # People
    path("users/", views.UserListView.as_view(), name="user-list"),
    path("users/<int:pk>/", views.UserDetailView.as_view(), name="user-detail"),
    path(
        "users/<int:pk>/posts/",
        views.UserPostsView.as_view(),
        name="user-posts",
    ),
    path(
        "users/<int:pk>/connect/",
        views.ConnectView.as_view(),
        name="user-connect",
    ),
    # Incoming connection requests (people asking to connect) + approve/reject.
    path(
        "connection-requests/",
        views.ConnectionRequestListView.as_view(),
        name="connection-request-list",
    ),
    path(
        "connection-requests/<int:pk>/approve/",
        views.ConnectionRequestActionView.as_view(action="approve"),
        name="connection-request-approve",
    ),
    path(
        "connection-requests/<int:pk>/reject/",
        views.ConnectionRequestActionView.as_view(action="reject"),
        name="connection-request-reject",
    ),
]
