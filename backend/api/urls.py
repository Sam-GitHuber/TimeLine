from django.urls import path

from . import views

urlpatterns = [
    path("hello", views.hello, name="hello"),
    # Authorization check for Caddy's forward_auth on /media/* (Phase 7).
    # Returns 204 only for a logged-in, active member; Caddy serves the file
    # only on that 2xx, so uploaded media isn't world-readable.
    path("media-auth/", views.media_auth, name="media-auth"),
    # Timeline
    path("feed/", views.FeedView.as_view(), name="feed"),
    path("posts/", views.PostCreateView.as_view(), name="post-create"),
    path(
        "posts/<int:pk>/comments/",
        views.PostCommentsView.as_view(),
        name="post-comments",
    ),
    # Reactions (Phase 7b): POST <path>/react/ toggles; GET <path>/reactions/
    # lists who reacted (both pruned to the viewer's visibility).
    path(
        "posts/<int:pk>/react/",
        views.PostReactionView.as_view(),
        name="post-react",
    ),
    path(
        "posts/<int:pk>/reactions/",
        views.PostReactionView.as_view(),
        name="post-reactions",
    ),
    path(
        "comments/<int:pk>/react/",
        views.CommentReactionView.as_view(),
        name="comment-react",
    ),
    path(
        "comments/<int:pk>/reactions/",
        views.CommentReactionView.as_view(),
        name="comment-reactions",
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
    path(
        "users/<int:pk>/block/",
        views.BlockView.as_view(),
        name="user-block",
    ),
    path(
        "users/<int:pk>/disconnect-impact/",
        views.DisconnectImpactView.as_view(),
        name="disconnect-impact",
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
    # Direct messaging (Phase 5)
    path(
        "conversations/",
        views.ConversationListCreateView.as_view(),
        name="conversation-list",
    ),
    path(
        "conversations/<int:pk>/",
        views.ConversationDetailView.as_view(),
        name="conversation-detail",
    ),
    path(
        "conversations/<int:pk>/participants/",
        views.ConversationParticipantsView.as_view(),
        name="conversation-participants",
    ),
    path(
        "conversations/<int:pk>/leave/",
        views.ConversationLeaveView.as_view(),
        name="conversation-leave",
    ),
    path(
        "conversations/<int:pk>/messages/",
        views.ConversationMessagesView.as_view(),
        name="conversation-messages",
    ),
    path(
        "conversations/<int:pk>/messages/<int:message_id>/",
        views.MessageDeleteView.as_view(),
        name="message-delete",
    ),
    path(
        "conversations/<int:pk>/read/",
        views.ConversationReadView.as_view(),
        name="conversation-read",
    ),
    path(
        "messages/unread-count/",
        views.UnreadMessageCountView.as_view(),
        name="unread-message-count",
    ),
    # Groups (Phase 6)
    path("groups/", views.GroupListCreateView.as_view(), name="group-list"),
    path(
        "groups/<int:pk>/",
        views.GroupDetailView.as_view(),
        name="group-detail",
    ),
    path(
        "groups/<int:pk>/posts/",
        views.GroupPostsView.as_view(),
        name="group-posts",
    ),
    path(
        "groups/<int:pk>/members/",
        views.GroupMembersView.as_view(),
        name="group-members",
    ),
    path(
        "groups/<int:pk>/members/<int:user_id>/",
        views.GroupMemberDetailView.as_view(),
        name="group-member-detail",
    ),
    path(
        "groups/<int:pk>/members/<int:user_id>/role/",
        views.GroupMemberRoleView.as_view(),
        name="group-member-role",
    ),
    # Incoming group invitations (people inviting *you*) + accept/reject.
    path(
        "group-invites/",
        views.GroupInviteListView.as_view(),
        name="group-invite-list",
    ),
    path(
        "group-invites/<int:pk>/accept/",
        views.GroupInviteActionView.as_view(action="accept"),
        name="group-invite-accept",
    ),
    path(
        "group-invites/<int:pk>/reject/",
        views.GroupInviteActionView.as_view(action="reject"),
        name="group-invite-reject",
    ),
    # Report a post/comment for the maintainer to review (Phase 7 takedown path).
    path("reports/", views.ReportCreateView.as_view(), name="report-create"),
    # Delete your own account + all your data (Phase 7 delete-my-data path).
    path(
        "account/delete/",
        views.DeleteAccountView.as_view(),
        name="account-delete",
    ),
]
