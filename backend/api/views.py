from django.contrib.auth import get_user_model
from django.db.models import Exists, OuterRef, Q
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import generics, status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Follow, Post
from .serializers import PostSerializer, UserListSerializer

User = get_user_model()


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
    """The home timeline: your own posts plus everyone you follow.

    Strictly newest-first (Post's default ordering) — no ranking, ever. This is
    the whole point of TimeLine (see docs/SHARED.md). Paginated.
    """

    serializer_class = PostSerializer

    def get_queryset(self):
        user = self.request.user
        following_ids = Follow.objects.filter(follower=user).values("followee")
        return (
            Post.objects.filter(Q(author=user) | Q(author__in=following_ids))
            .select_related("author")
        )


class PostCreateView(generics.CreateAPIView):
    """Create a post as the logged-in user."""

    serializer_class = PostSerializer

    def perform_create(self, serializer):
        # Author comes from the session, never the request body.
        serializer.save(author=self.request.user)


class UserPostsView(generics.ListAPIView):
    """One person's own posts, newest-first — drives the profile page."""

    serializer_class = PostSerializer

    def get_queryset(self):
        # 404 for an unknown/inactive user rather than a silently empty list.
        author = get_object_or_404(User, pk=self.kwargs["pk"], is_active=True)
        return Post.objects.filter(author=author).select_related("author")


class UserListView(generics.ListAPIView):
    """People to follow: every other active member, with a follow flag.

    ``is_following`` is annotated so the frontend can render Follow/Unfollow
    without a second round-trip per user.
    """

    serializer_class = UserListSerializer

    def get_queryset(self):
        user = self.request.user
        follows = Follow.objects.filter(
            follower=user, followee=OuterRef("pk")
        )
        return (
            User.objects.filter(is_active=True)
            .exclude(pk=user.pk)
            .annotate(is_following=Exists(follows))
            .order_by("first_name", "last_name", "email")
        )


class UserDetailView(generics.RetrieveAPIView):
    """A single member's public details (for the profile header)."""

    serializer_class = UserListSerializer

    def get_queryset(self):
        user = self.request.user
        follows = Follow.objects.filter(
            follower=user, followee=OuterRef("pk")
        )
        return User.objects.filter(is_active=True).annotate(
            is_following=Exists(follows)
        )


class FollowView(APIView):
    """Follow (POST) or unfollow (DELETE) the user at ``/users/<pk>/follow/``.

    Both are idempotent: following someone you already follow, or unfollowing
    someone you don't, is a no-op that still returns success. You can't follow
    yourself (400) or a non-existent/inactive user (404).
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
        Follow.objects.get_or_create(follower=request.user, followee=target)
        return Response(
            {"detail": "Followed.", "is_following": True},
            status=status.HTTP_201_CREATED,
        )

    def delete(self, request, pk):
        target = self._target(pk)
        Follow.objects.filter(follower=request.user, followee=target).delete()
        return Response(
            {"detail": "Unfollowed.", "is_following": False},
            status=status.HTTP_200_OK,
        )
