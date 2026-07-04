from django.contrib.auth import get_user_model
from django.db.models import OuterRef, Q, Subquery, Value
from django.db.models.functions import Coalesce
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import generics, status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Follow, Post
from .serializers import (
    FollowRequestSerializer,
    PostSerializer,
    UserListSerializer,
)

User = get_user_model()

ACCEPTED = Follow.Status.ACCEPTED
PENDING = Follow.Status.PENDING


def accepted_followee_ids(user):
    """User ids whose posts ``user`` is allowed to see: everyone they follow
    with an *accepted* follow. Pending requests don't count."""
    return Follow.objects.filter(follower=user, status=ACCEPTED).values(
        "followee"
    )


def follow_status_annotation(user):
    """Annotate a User queryset with ``follow_status`` — the requesting user's
    follow toward each row: "accepted", "pending", or "none"."""
    my_follow = Follow.objects.filter(
        follower=user, followee=OuterRef("pk")
    ).values("status")[:1]
    return Coalesce(Subquery(my_follow), Value("none"))


@api_view(["GET"])
@permission_classes([AllowAny])
def hello(request):
    """Phase 0 smoke-test endpoint.

    Proves the frontend can reach the backend and the backend is alive.
    Returns a tiny JSON payload; no database or auth involved.
    """
    return Response(
        {
            "message": "Hello from the TimeLine backend 👋",
            "service": "backend",
            "time": timezone.now().isoformat(),
        }
    )


class FeedView(generics.ListAPIView):
    """The home timeline: your own posts plus everyone you follow (accepted).

    Strictly newest-first (Post's default ordering) — no ranking, ever. This is
    the whole point of TimeLine (see docs/SHARED.md). Paginated.
    """

    serializer_class = PostSerializer

    def get_queryset(self):
        user = self.request.user
        return Post.objects.filter(
            Q(author=user) | Q(author__in=accepted_followee_ids(user))
        ).select_related("author")


class PostCreateView(generics.CreateAPIView):
    """Create a post as the logged-in user."""

    serializer_class = PostSerializer

    def perform_create(self, serializer):
        # Author comes from the session, never the request body.
        serializer.save(author=self.request.user)


class UserPostsView(generics.ListAPIView):
    """One person's own posts, newest-first — drives the profile page.

    Private-by-default: you only see a user's posts if it's you, or you have an
    *accepted* follow. Otherwise the list is empty (the profile page explains
    why and offers a follow button).
    """

    serializer_class = PostSerializer

    def get_queryset(self):
        # 404 for an unknown/inactive user rather than a silently empty list.
        author = get_object_or_404(User, pk=self.kwargs["pk"], is_active=True)
        me = self.request.user
        allowed = author == me or Follow.objects.filter(
            follower=me, followee=author, status=ACCEPTED
        ).exists()
        if not allowed:
            return Post.objects.none()
        return Post.objects.filter(author=author).select_related("author")


class UserListView(generics.ListAPIView):
    """People to follow: every other active member, with your follow status."""

    serializer_class = UserListSerializer

    def get_queryset(self):
        user = self.request.user
        return (
            User.objects.filter(is_active=True)
            .exclude(pk=user.pk)
            .annotate(follow_status=follow_status_annotation(user))
            .order_by("first_name", "last_name", "email")
        )


class UserDetailView(generics.RetrieveAPIView):
    """A single member's public details (for the profile header)."""

    serializer_class = UserListSerializer

    def get_queryset(self):
        user = self.request.user
        return User.objects.filter(is_active=True).annotate(
            follow_status=follow_status_annotation(user)
        )


class FollowView(APIView):
    """Request to follow (POST) or unfollow / cancel a request (DELETE) the
    user at ``/users/<pk>/follow/``.

    Accounts are private: POST creates a **pending** request that the requestee
    must approve before it takes effect — it does not grant access on its own.
    Both verbs are idempotent. You can't follow yourself (400) or a
    non-existent/inactive user (404). DELETE removes the row whatever its
    status, so it both cancels a pending request and unfollows an accepted one.
    """

    def _target(self, pk):
        return get_object_or_404(User, pk=pk, is_active=True)

    def post(self, request, pk):
        target = self._target(pk)
        if target == request.user:
            return Response(
                {"detail": "You can't follow yourself."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        follow, _created = Follow.objects.get_or_create(
            follower=request.user, followee=target
        )
        return Response(
            {"detail": "Request sent.", "follow_status": follow.status},
            status=status.HTTP_201_CREATED,
        )

    def delete(self, request, pk):
        target = self._target(pk)
        Follow.objects.filter(follower=request.user, followee=target).delete()
        return Response(
            {"detail": "Removed.", "follow_status": "none"},
            status=status.HTTP_200_OK,
        )


class FollowRequestListView(generics.ListAPIView):
    """Incoming follow requests: people who've asked to follow *you* and are
    waiting on your approval."""

    serializer_class = FollowRequestSerializer

    def get_queryset(self):
        return (
            Follow.objects.filter(followee=self.request.user, status=PENDING)
            .select_related("follower")
            .order_by("-created_at")
        )


class FollowRequestActionView(APIView):
    """Approve (grant the follow) or reject (delete the request) an incoming
    follow request. Wired to two URLs via ``.as_view(action=...)``:
    ``/follow-requests/<pk>/approve/`` and ``.../reject/``.

    Only the requestee may act on it: the row must have ``followee == you`` and
    still be pending, else 404 (we don't reveal requests addressed to others).
    """

    # Set per-URL by as_view(action="approve"|"reject").
    action = None

    def post(self, request, pk):
        follow = get_object_or_404(
            Follow, pk=pk, followee=request.user, status=PENDING
        )
        if self.action == "approve":
            follow.status = ACCEPTED
            follow.save(update_fields=["status"])
            return Response({"detail": "Approved."}, status=status.HTTP_200_OK)
        follow.delete()
        return Response({"detail": "Rejected."}, status=status.HTTP_200_OK)
