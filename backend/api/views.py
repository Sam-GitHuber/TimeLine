from collections import defaultdict

from django.contrib.auth import get_user_model
from django.db.models import Case, Exists, OuterRef, Q, Value, When
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import generics, status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Comment, Connection, Post
from .serializers import (
    CommentCreateSerializer,
    CommentSerializer,
    ConnectionRequestSerializer,
    PostSerializer,
    UserListSerializer,
)

User = get_user_model()

ACCEPTED = Connection.Status.ACCEPTED
PENDING = Connection.Status.PENDING


def connected_user_ids(user):
    """The set of user ids ``user`` is connected with (accepted, either way).

    A connection is symmetric once accepted, so the row can name ``user`` as
    *either* endpoint — we return the *other* endpoint each time. This single
    "who can I see" set is what the feed, profiles, and the comment tree all key
    off, so those three surfaces can't drift apart.
    """
    pairs = Connection.objects.filter(
        Q(requester=user) | Q(requestee=user), status=ACCEPTED
    ).values_list("requester_id", "requestee_id")
    return {
        requestee if requester == user.id else requester
        for requester, requestee in pairs
    }


def visible_posts(user, author=None):
    """The posts ``user`` is allowed to see, newest-first.

    Private-by-default, in one place so the feed and a profile can't drift: a
    post is visible only if ``user`` wrote it or is **connected** with its
    author, and only if that author is still active (a deactivated/banned member
    disappears from feeds too, not just from the people list). Pass ``author``
    to narrow to a single person's posts (the profile page) — the same rule then
    yields their posts if allowed, or nothing if not.
    """
    qs = Post.objects.filter(
        Q(author=user) | Q(author__in=connected_user_ids(user)),
        author__is_active=True,
    ).select_related("author")
    if author is not None:
        qs = qs.filter(author=author)
    return qs


def connection_status_annotation(user):
    """Annotate a User queryset with ``connection_status`` — the requesting
    user's relationship to each row, driving the Connect button:

    - ``"connected"``  — an accepted connection (either direction),
    - ``"requested"``  — you sent a request, awaiting their approval,
    - ``"incoming"``   — they sent a request, awaiting *your* approval,
    - ``"none"``       — no connection.
    """
    accepted = Connection.objects.filter(
        Q(requester=user, requestee=OuterRef("pk"))
        | Q(requester=OuterRef("pk"), requestee=user),
        status=ACCEPTED,
    )
    outgoing = Connection.objects.filter(
        requester=user, requestee=OuterRef("pk"), status=PENDING
    )
    incoming = Connection.objects.filter(
        requester=OuterRef("pk"), requestee=user, status=PENDING
    )
    return Case(
        When(Exists(accepted), then=Value("connected")),
        When(Exists(outgoing), then=Value("requested")),
        When(Exists(incoming), then=Value("incoming")),
        default=Value("none"),
    )


def build_visible_comment_tree(comments, user):
    """Turn a flat list of a post's comments into the nested tree ``user`` may
    see, pruning whole subtrees rooted at a not-connected author.

    Visibility rule (issue #12): you see a comment only if its author is you or
    someone you're connected with. Crucially, if a comment is hidden, everything
    **below** it is hidden too — even a reply from someone you *are* connected
    with — so you never see half a conversation with invisible participants, and
    strangers can't be surfaced to you second-hand through a thread.

    Each surviving comment gets a ``_visible_children`` list of its visible
    replies (read by the serializer). ``comments`` is assumed to arrive in the
    model's ``created_at, id`` order, which we preserve within each sibling set.
    """
    visible_authors = connected_user_ids(user)
    visible_authors.add(user.id)

    children = defaultdict(list)
    for comment in comments:
        children[comment.parent_id].append(comment)

    def build(parent_id):
        nodes = []
        for comment in children.get(parent_id, []):
            if comment.author_id not in visible_authors:
                # Prune this node AND its whole subtree: don't recurse into it.
                continue
            comment._visible_children = build(comment.id)
            nodes.append(comment)
        return nodes

    return build(None)


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
    """The home timeline: your own posts plus everyone you're connected with.

    Strictly newest-first (Post's default ordering) — no ranking, ever. This is
    the whole point of TimeLine (see docs/SHARED.md). Paginated.
    """

    serializer_class = PostSerializer

    def get_queryset(self):
        return visible_posts(self.request.user)


class PostCreateView(generics.CreateAPIView):
    """Create a post as the logged-in user."""

    serializer_class = PostSerializer

    def perform_create(self, serializer):
        # Author comes from the session, never the request body.
        serializer.save(author=self.request.user)


class UserPostsView(generics.ListAPIView):
    """One person's own posts, newest-first — drives the profile page.

    Private-by-default: you only see a user's posts if it's you, or you're
    connected. Otherwise the list is empty (the profile page explains why and
    offers a Connect button).
    """

    serializer_class = PostSerializer

    def get_queryset(self):
        # 404 for an unknown/inactive user rather than a silently empty list;
        # visible_posts then applies the shared private-by-default gate (returns
        # their posts if we're allowed to see them, otherwise nothing).
        author = get_object_or_404(User, pk=self.kwargs["pk"], is_active=True)
        return visible_posts(self.request.user, author=author)


class UserListView(generics.ListAPIView):
    """People to connect with: every other active member, with your status."""

    serializer_class = UserListSerializer

    def get_queryset(self):
        user = self.request.user
        return (
            User.objects.filter(is_active=True)
            .exclude(pk=user.pk)
            .annotate(connection_status=connection_status_annotation(user))
            .order_by("first_name", "last_name", "email")
        )


class UserDetailView(generics.RetrieveAPIView):
    """A single member's public details (for the profile header)."""

    serializer_class = UserListSerializer

    def get_queryset(self):
        user = self.request.user
        return User.objects.filter(is_active=True).annotate(
            connection_status=connection_status_annotation(user)
        )


class ConnectView(APIView):
    """Request a connection (POST) or disconnect / cancel a request (DELETE)
    with the user at ``/users/<pk>/connect/``.

    Accounts are private: POST creates a **pending** request that the other
    person must approve before either of you sees the other's posts — it grants
    nothing on its own. **Except** when they've *already* requested you: then the
    mutual intent is clear, so POST accepts the existing request instead of
    creating a competing row (which the one-row-per-pair constraint would reject
    anyway). Both verbs are idempotent. You can't connect with yourself (400) or
    a non-existent/inactive user (404). DELETE removes the row whatever its
    status, so it cancels a pending request or ends an accepted connection.
    """

    def _target(self, pk):
        return get_object_or_404(User, pk=pk, is_active=True)

    def _existing(self, user, target):
        return Connection.objects.filter(
            Q(requester=user, requestee=target)
            | Q(requester=target, requestee=user)
        ).first()

    def post(self, request, pk):
        target = self._target(pk)
        if target == request.user:
            return Response(
                {"detail": "You can't connect with yourself."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        existing = self._existing(request.user, target)
        if existing is None:
            Connection.objects.create(
                requester=request.user, requestee=target
            )
            return Response(
                {"detail": "Request sent.", "connection_status": "requested"},
                status=status.HTTP_201_CREATED,
            )
        if existing.status == ACCEPTED:
            return Response(
                {
                    "detail": "Already connected.",
                    "connection_status": "connected",
                },
                status=status.HTTP_200_OK,
            )
        # A pending request already exists between the two of you.
        if existing.requestee_id == request.user.id:
            # They asked you first — approving it connects you both now.
            existing.status = ACCEPTED
            existing.save(update_fields=["status"])
            return Response(
                {"detail": "Connected.", "connection_status": "connected"},
                status=status.HTTP_200_OK,
            )
        # You'd already requested them; nothing to do (idempotent).
        return Response(
            {
                "detail": "Request already sent.",
                "connection_status": "requested",
            },
            status=status.HTTP_200_OK,
        )

    def delete(self, request, pk):
        target = self._target(pk)
        Connection.objects.filter(
            Q(requester=request.user, requestee=target)
            | Q(requester=target, requestee=request.user)
        ).delete()
        return Response(
            {"detail": "Removed.", "connection_status": "none"},
            status=status.HTTP_200_OK,
        )


class ConnectionRequestListView(generics.ListAPIView):
    """Incoming connection requests: people who've asked to connect with *you*
    and are waiting on your approval."""

    serializer_class = ConnectionRequestSerializer

    def get_queryset(self):
        return (
            Connection.objects.filter(
                requestee=self.request.user, status=PENDING
            )
            .select_related("requester")
            .order_by("-created_at")
        )


class ConnectionRequestActionView(APIView):
    """Approve (make the connection mutual) or reject (delete the request) an
    incoming connection request. Wired to two URLs via ``.as_view(action=...)``:
    ``/connection-requests/<pk>/approve/`` and ``.../reject/``.

    Only the requestee may act on it: the row must have ``requestee == you`` and
    still be pending, else 404 (we don't reveal requests addressed to others).
    """

    # Set per-URL by as_view(action="approve"|"reject").
    action = None

    def post(self, request, pk):
        connection = get_object_or_404(
            Connection, pk=pk, requestee=request.user, status=PENDING
        )
        if self.action == "approve":
            connection.status = ACCEPTED
            connection.save(update_fields=["status"])
            return Response({"detail": "Approved."}, status=status.HTTP_200_OK)
        connection.delete()
        return Response({"detail": "Rejected."}, status=status.HTTP_200_OK)


class PostCommentsView(APIView):
    """The comment tree for a post (GET) and adding a comment/reply (POST) at
    ``/posts/<pk>/comments/``.

    You must be able to *see* the post (be its author or connected with them) —
    otherwise 404, same as the profile gate. GET returns the tree already pruned
    to what you may see (a not-connected author's comment and its whole subtree
    are omitted server-side, so hidden content never reaches the client). POST
    adds a comment, or a reply when ``parent`` is given; the author is taken
    from the session, never the body.
    """

    def _post(self, request, pk):
        # Reuse the shared visibility gate: 404 if you can't see this post.
        return get_object_or_404(visible_posts(request.user), pk=pk)

    def get(self, request, pk):
        post = self._post(request, pk)
        comments = list(post.comments.select_related("author").all())
        tree = build_visible_comment_tree(comments, request.user)
        data = CommentSerializer(
            tree, many=True, context={"request": request}
        ).data
        return Response(data)

    def post(self, request, pk):
        post = self._post(request, pk)
        serializer = CommentCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        parent = serializer.validated_data.get("parent")
        if parent is not None and parent.post_id != post.id:
            raise ValidationError(
                {"parent": "You can only reply to a comment on this post."}
            )
        serializer.save(author=request.user, post=post)
        return Response(serializer.data, status=status.HTTP_201_CREATED)
