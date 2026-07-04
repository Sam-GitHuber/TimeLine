from django.utils import timezone
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response


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
