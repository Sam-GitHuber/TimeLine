"""Drain the push outbox: send queued notifications to Expo (Phase 9, D).

Run on a systemd timer (``deploy/send-pushes.timer``), not from a web request —
see ``PushOutbox`` for why the send is out-of-band.

The flow per drain:

1. Take the oldest unsent rows that haven't exhausted their retries.
2. Resolve each recipient's *current* device tokens (looked up now, not at
   enqueue time, so a rotated token still gets the push).
3. Build one Expo message per (notification × device) and POST in batches.
4. Read the reply's per-message tickets: mark sent, record errors, and delete
   tokens Expo reports as ``DeviceNotRegistered``.
5. Prune delivered rows older than the retention window.

The notification's wording and deep-link come straight from
``NotificationSerializer`` — the same ``text`` and ``url`` the web activity
centre renders, so a push and the in-app row can never drift apart.
"""

import json
import urllib.request
from datetime import timedelta

from django.conf import settings
from django.core.management.base import BaseCommand
from django.db.models import Q
from django.utils import timezone

from ...models import DevicePushToken, PushOutbox
from ...serializers import NotificationSerializer

# Expo's reply carries one ticket per message, in the order sent.
_DEVICE_NOT_REGISTERED = "DeviceNotRegistered"


class Command(BaseCommand):
    help = "Send queued push notifications to Expo's push service."

    def add_arguments(self, parser):
        parser.add_argument(
            "--limit",
            type=int,
            default=settings.EXPO_PUSH_BATCH_SIZE,
            help="Maximum messages to send in this run.",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Show what would be sent without calling Expo or writing state.",
        )

    def handle(self, *args, **options):
        limit = options["limit"]
        dry_run = options["dry_run"]

        pending = list(
            PushOutbox.objects.filter(
                sent_at__isnull=True,
                attempts__lt=PushOutbox.MAX_ATTEMPTS,
            )
            .select_related("notification", "notification__actor")
            .order_by("created_at")[:limit]
        )
        if not pending:
            self.stdout.write("Nothing queued.")
            self._prune(dry_run)
            return

        # One query for every recipient's devices, rather than one per row.
        recipient_ids = {row.notification.recipient_id for row in pending}
        tokens_by_user = {}
        for device in DevicePushToken.objects.filter(user_id__in=recipient_ids):
            tokens_by_user.setdefault(device.user_id, []).append(device)

        messages = []
        for row in pending:
            devices = tokens_by_user.get(row.notification.recipient_id, [])
            if not devices:
                # Nobody to push to — a web-only user. Mark it done rather than
                # retrying every tick forever; the in-app notification still
                # exists and is unaffected.
                if not dry_run:
                    row.sent_at = timezone.now()
                    row.save(update_fields=["sent_at"])
                continue
            data = NotificationSerializer(row.notification).data
            for device in devices:
                messages.append((row, device, self._message(device, data)))

        if not messages:
            self.stdout.write(f"{len(pending)} queued, no registered devices.")
            self._prune(dry_run)
            return

        if dry_run:
            for _row, device, message in messages:
                self.stdout.write(f"→ {device.expo_token[:20]}… {message['body']}")
            self.stdout.write(f"Dry run: {len(messages)} message(s) not sent.")
            return

        self._send(messages)
        self._prune(dry_run)

    def _message(self, device, data):
        """One Expo push message from a serialized notification.

        ``data`` is what the app reads on tap to deep-link: ``url`` is the same
        route string the web app uses (e.g. ``/p/12?comment=34``), which the app
        maps onto its native route.
        """
        return {
            "to": device.expo_token,
            "title": "TimeLine",
            "body": data["text"],
            "sound": "default",
            "data": {
                "notificationId": data["id"],
                "kind": data["kind"],
                "url": data["url"],
            },
        }

    def _send(self, messages):
        sent = failed = 0
        batch_size = settings.EXPO_PUSH_BATCH_SIZE
        for start in range(0, len(messages), batch_size):
            chunk = messages[start : start + batch_size]
            try:
                tickets = self._post([message for _row, _device, message in chunk])
            except Exception as exc:  # network, timeout, non-200, bad JSON
                # Whole batch failed: count an attempt on each row so a
                # persistently-broken send eventually stops being retried.
                for row, _device, _message in chunk:
                    self._record_failure(row, str(exc))
                failed += len(chunk)
                self.stderr.write(f"Batch failed: {exc}")
                continue

            # strict=True: _post already rejects a reply whose ticket count
            # doesn't match, and this makes a silent truncation impossible if
            # that check ever regresses — a lost ticket means a row wrongly
            # left queued or a dead token never cleaned up.
            for (row, device, _message), ticket in zip(chunk, tickets, strict=True):
                if ticket.get("status") == "ok":
                    if row.sent_at is None:
                        row.sent_at = timezone.now()
                        row.save(update_fields=["sent_at"])
                    sent += 1
                    continue

                error = (ticket.get("details") or {}).get("error")
                if error == _DEVICE_NOT_REGISTERED:
                    # The app was uninstalled or the token rotated. Drop the
                    # device so we stop pushing into the void; this is the only
                    # signal Expo gives us that a token is permanently dead.
                    device.delete()
                    if row.sent_at is None:
                        row.sent_at = timezone.now()
                        row.save(update_fields=["sent_at"])
                    continue

                self._record_failure(row, ticket.get("message", "unknown error"))
                failed += 1

        self.stdout.write(f"Sent {sent}, failed {failed}.")

    def _post(self, payload):
        """POST a batch to Expo and return its list of tickets."""
        body = json.dumps(payload).encode()
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if settings.EXPO_ACCESS_TOKEN:
            headers["Authorization"] = f"Bearer {settings.EXPO_ACCESS_TOKEN}"

        request = urllib.request.Request(
            settings.EXPO_PUSH_URL, data=body, headers=headers, method="POST"
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            parsed = json.loads(response.read().decode())

        tickets = parsed.get("data")
        if not isinstance(tickets, list) or len(tickets) != len(payload):
            raise ValueError(f"unexpected Expo reply: {parsed!r}")
        return tickets

    def _record_failure(self, row, message):
        row.attempts += 1
        row.last_error = message[:500]
        row.save(update_fields=["attempts", "last_error"])

    def _prune(self, dry_run):
        """Delete delivered rows past the retention window."""
        cutoff = timezone.now() - timedelta(days=settings.EXPO_PUSH_RETENTION_DAYS)
        stale = PushOutbox.objects.filter(
            Q(sent_at__isnull=False, sent_at__lt=cutoff)
            # Rows that exhausted their retries are dead too; don't keep them
            # blocking the queue's index forever.
            | Q(attempts__gte=PushOutbox.MAX_ATTEMPTS, created_at__lt=cutoff)
        )
        if dry_run:
            self.stdout.write(f"Would prune {stale.count()} row(s).")
            return
        deleted, _ = stale.delete()
        if deleted:
            self.stdout.write(f"Pruned {deleted} row(s).")
