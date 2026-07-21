"""Drain the push outbox: send queued notifications to Expo (Phase 9, D).

Run on a systemd timer (``deploy/send-pushes.timer``), not from a web request —
see ``PushOutbox`` for why the send is out-of-band.

The flow per drain:

1. Take the oldest unsent rows that haven't exhausted their retries, locking
   them so a hand-run and a timer tick can't send the same push twice.
2. Resolve each recipient's *current* device tokens (looked up now, not at
   enqueue time, so a rotated token still gets the push), skipping any device
   this row has already reached.
3. Build one Expo message per (notification × outstanding device) and POST in
   batches.
4. Read the reply's per-message tickets, then settle each row: delivered
   everywhere → mark sent; anything still outstanding → record the error and
   leave it queued for the next tick. Tokens Expo reports as
   ``DeviceNotRegistered`` are deleted, and every accepted ticket is recorded as
   a ``PushReceipt`` to be followed up in step 5.
5. Check delivery *receipts* for tickets old enough to have one. A ticket says
   Expo accepted the message; only the receipt says whether Apple/Google
   delivered it — so this is the step that reaps tokens which died *after*
   registration. See ``PushReceipt`` for why that would otherwise be silent.
6. Prune delivered rows older than the retention window.

The notification's wording and deep-link come straight from
``NotificationSerializer`` — the same ``text`` and ``url`` the web activity
centre renders, so a push and the in-app row can never drift apart.
"""

import json
import urllib.parse
import urllib.request
from datetime import timedelta

from django.conf import settings
from django.core.management.base import BaseCommand
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from ...models import DevicePushToken, PushOutbox, PushReceipt
from ...serializers import NotificationSerializer

# Expo's reply carries one ticket per message, in the order sent.
_DEVICE_NOT_REGISTERED = "DeviceNotRegistered"


class Command(BaseCommand):
    help = "Send queued push notifications to Expo's push service."

    def add_arguments(self, parser):
        parser.add_argument(
            "--max-rows",
            type=int,
            default=settings.EXPO_PUSH_MAX_ROWS,
            help="Maximum outbox rows to drain in this run (not messages).",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Show what would be sent without calling Expo or writing state.",
        )

    def handle(self, *args, **options):
        max_rows = options["max_rows"]
        dry_run = options["dry_run"]

        if dry_run:
            self._drain(max_rows, dry_run=True)
        else:
            # One transaction around the select-and-claim so concurrent runs
            # can't pick up the same rows. The Expo calls happen inside it,
            # which is acceptable here: this is a background job with a capped
            # batch, and the alternative (claim, commit, send) needs a separate
            # in-flight state to avoid losing rows if the process dies.
            with transaction.atomic():
                self._drain(max_rows, dry_run=False)
        # Deliberately outside the drain's transaction and its try/except: a
        # receipts failure must not roll back sends that already happened, and a
        # send failure must not stop us reaping dead tokens.
        self._check_receipts(dry_run)
        self._prune(dry_run)

    def _drain(self, max_rows, *, dry_run):
        rows = PushOutbox.objects.filter(
            sent_at__isnull=True,
            attempts__lt=PushOutbox.MAX_ATTEMPTS,
        ).select_related(
            "notification",
            "notification__actor",
            # The serializer reads through these for the text and deep-link
            # (comment → parent post, event → group, group → name). Without
            # them each comment/event/group notification costs extra queries.
            "notification__comment",
            "notification__event",
            "notification__group",
        )
        if not dry_run:
            # skip_locked: a concurrent run takes different rows rather than
            # blocking on ours.
            rows = rows.select_for_update(skip_locked=True, of=("self",))

        pending = list(rows.order_by("created_at")[:max_rows])
        if not pending:
            self.stdout.write("Nothing queued.")
            return

        # One query for every recipient's devices, rather than one per row.
        recipient_ids = {row.notification.recipient_id for row in pending}
        devices_by_user = {}
        for device in DevicePushToken.objects.filter(user_id__in=recipient_ids):
            devices_by_user.setdefault(device.user_id, []).append(device)

        messages = []
        for row in pending:
            # Skip devices this row already reached on an earlier attempt, so a
            # retry never re-buzzes a phone that got it the first time.
            delivered = set(row.delivered_tokens or [])
            outstanding = [
                device
                for device in devices_by_user.get(row.notification.recipient_id, [])
                if device.expo_token not in delivered
            ]
            if not outstanding:
                # Either a web-only user with no devices at all, or every device
                # was reached earlier. Settle it rather than retrying forever;
                # the in-app notification exists and is unaffected either way.
                if not dry_run:
                    row.sent_at = timezone.now()
                    row.save(update_fields=["sent_at"])
                continue
            data = NotificationSerializer(row.notification).data
            for device in outstanding:
                messages.append((row, device, self._message(device, data)))

        if not messages:
            self.stdout.write(f"{len(pending)} queued, nothing outstanding to send.")
            return

        if dry_run:
            for _row, device, message in messages:
                self.stdout.write(f"→ {device.expo_token[:20]}… {message['body']}")
            self.stdout.write(f"Dry run: {len(messages)} message(s) not sent.")
            return

        self._send(messages)

    def _message(self, device, data):
        """One Expo push message from a serialized notification.

        Deliberately carries **no post or comment content** — only the
        server-phrased line ("Ada replied to your post"). The body transits
        Expo's servers and Apple's, so it names people but never quotes them.

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
        """POST every message, then settle each row by what happened to it.

        Results are accumulated across chunks before any row is written,
        because one row's devices can straddle a chunk boundary — settling
        mid-loop would mark a row sent while some of its devices were still
        unsent.
        """
        # row.pk → {"row", "delivered": [...], "errors": [...]}
        outcomes = {}
        # Accepted tickets, to be followed up for a delivery receipt later.
        receipts = []

        def outcome(row):
            return outcomes.setdefault(
                row.pk, {"row": row, "delivered": [], "errors": []}
            )

        batch_size = settings.EXPO_PUSH_BATCH_SIZE
        for start in range(0, len(messages), batch_size):
            chunk = messages[start : start + batch_size]
            try:
                tickets = self._post([message for _row, _device, message in chunk])
            except Exception as exc:  # network, timeout, non-200, bad JSON
                for row, _device, _message in chunk:
                    outcome(row)["errors"].append(str(exc))
                self.stderr.write(f"Batch failed: {exc}")
                continue

            # strict=True: _post already rejects a reply whose ticket count
            # doesn't match, and this makes a silent truncation impossible if
            # that check ever regresses — a lost ticket means a row wrongly
            # left queued or a dead token never cleaned up.
            for (row, device, _message), ticket in zip(chunk, tickets, strict=True):
                if ticket.get("status") == "ok":
                    outcome(row)["delivered"].append(device.expo_token)
                    # "ok" means Expo accepted it, not that a phone got it.
                    # Record the ticket so _check_receipts can ask later what
                    # actually happened; without this, a token that died after
                    # registration fails silently forever.
                    ticket_id = ticket.get("id")
                    if ticket_id:
                        receipts.append(
                            PushReceipt(
                                ticket_id=ticket_id,
                                expo_token=device.expo_token,
                            )
                        )
                    continue

                error = (ticket.get("details") or {}).get("error")
                if error == _DEVICE_NOT_REGISTERED:
                    # The app was uninstalled or the token rotated. Drop the
                    # device so we stop pushing into the void; this is the only
                    # signal Expo gives us that a token is permanently dead.
                    # Counts as settled, not failed — retrying can't help.
                    device.delete()
                    outcome(row)["delivered"].append(device.expo_token)
                    continue

                outcome(row)["errors"].append(
                    ticket.get("message", "unknown error")
                )

        sent = requeued = 0
        for entry in outcomes.values():
            row = entry["row"]
            if entry["delivered"]:
                row.delivered_tokens = list(
                    dict.fromkeys([*(row.delivered_tokens or []), *entry["delivered"]])
                )
            if entry["errors"]:
                # Something is still outstanding: keep it queued so the next
                # tick retries *only* the devices not in delivered_tokens.
                row.attempts += 1
                row.last_error = entry["errors"][0][:500]
                requeued += 1
            else:
                row.sent_at = timezone.now()
                sent += 1
            row.save(
                update_fields=[
                    "delivered_tokens",
                    "attempts",
                    "last_error",
                    "sent_at",
                ]
            )

        if receipts:
            # ignore_conflicts: ticket_id is unique, and Expo has been known to
            # repeat one across a retry. A duplicate is not worth failing the
            # whole drain over — we already hold the row we need.
            PushReceipt.objects.bulk_create(receipts, ignore_conflicts=True)

        self.stdout.write(f"Sent {sent}, requeued {requeued}.")

    def _post(self, payload):
        """POST a batch of messages to Expo and return its list of tickets."""
        parsed = self._request(settings.EXPO_PUSH_URL, payload, "EXPO_PUSH_URL")
        tickets = parsed.get("data")
        if not isinstance(tickets, list) or len(tickets) != len(payload):
            raise ValueError(f"unexpected Expo reply: {parsed!r}")
        return tickets

    def _request(self, url, payload, setting_name):
        """POST JSON to an Expo endpoint and return the decoded reply.

        Shared by the send and receipts calls so both get the same timeout,
        auth header, and — importantly — the same scheme check.
        """
        body = json.dumps(payload).encode()
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if settings.EXPO_ACCESS_TOKEN:
            headers["Authorization"] = f"Bearer {settings.EXPO_ACCESS_TOKEN}"

        # Check the scheme before opening. These URLs come from the
        # environment, and urlopen honours file:// and custom schemes — so
        # without this a typo'd or hostile value could make this read a local
        # file and feed its contents to the reply parser instead of making an
        # HTTPS request. Expo is https-only, so anything else is a
        # misconfiguration worth failing loudly on. (This is bandit's B310.)
        if urllib.parse.urlparse(url).scheme != "https":
            raise ValueError(
                f"{setting_name} must be an https:// URL, got {url!r}"
            )

        request = urllib.request.Request(
            url, data=body, headers=headers, method="POST"
        )
        with urllib.request.urlopen(  # nosec B310 — scheme pinned to https above
            request, timeout=30
        ) as response:
            return json.loads(response.read().decode())

    def _check_receipts(self, dry_run):
        """Ask Expo what actually happened to tickets we sent earlier.

        This is the step that closes the gap between "Expo accepted it" and "a
        phone got it". Its main job is reaping ``DeviceNotRegistered`` tokens
        that were still live at send time and died before delivery — the case
        the ticket-time check cannot catch.

        Three outcomes per receipt, and one non-outcome:

        - **ok** — delivered. Drop the row; nothing more to learn.
        - **DeviceNotRegistered** — the app was uninstalled or the token
          retired. Delete the device so we stop pushing into the void.
        - **any other error** — log it and drop the row. There is nothing to
          retry: the message is already gone, and the outbox row was settled at
          ticket time.
        - **absent from the reply** — Expo has no receipt *yet*. Leave the row
          for a later run.
        """
        now = timezone.now()

        # Expire first, then select — so the batch below can't contain rows we
        # are about to delete, and neither step has to reconcile with the other.
        # Expo drops receipts after ~24h, so anything older will never be
        # answered; reap them or they accumulate exactly as the dead tokens
        # would have.
        expired = PushReceipt.objects.filter(
            created_at__lt=now - timedelta(hours=settings.EXPO_RECEIPT_MAX_AGE_HOURS)
        )
        ready = PushReceipt.objects.filter(
            created_at__lte=now
            - timedelta(seconds=settings.EXPO_RECEIPT_CHECK_DELAY_SECONDS),
            created_at__gte=now
            - timedelta(hours=settings.EXPO_RECEIPT_MAX_AGE_HOURS),
        ).order_by("created_at")

        if dry_run:
            self.stdout.write(
                f"Would check {ready.count()} receipt(s), "
                f"expire {expired.count()}."
            )
            return

        expired_count, _ = expired.delete()
        if expired_count:
            self.stdout.write(
                f"Gave up on {expired_count} receipt(s) past Expo's window."
            )

        pending = list(ready[: settings.EXPO_RECEIPT_BATCH_SIZE])
        if not pending:
            return

        by_ticket = {row.ticket_id: row for row in pending}
        try:
            parsed = self._request(
                settings.EXPO_RECEIPTS_URL,
                {"ids": list(by_ticket)},
                "EXPO_RECEIPTS_URL",
            )
        except Exception as exc:  # network, timeout, non-200, bad JSON
            # Leave every row in place; the next tick retries, and the expiry
            # above stops that going on forever.
            self.stderr.write(f"Receipt check failed: {exc}")
            return

        results = parsed.get("data")
        if not isinstance(results, dict):
            self.stderr.write(f"Unexpected Expo receipts reply: {parsed!r}")
            return

        settled, dead_tokens = [], set()
        for ticket_id, receipt in results.items():
            row = by_ticket.get(ticket_id)
            if row is None:
                continue
            settled.append(row.pk)
            if receipt.get("status") == "ok":
                continue
            error = (receipt.get("details") or {}).get("error")
            if error == _DEVICE_NOT_REGISTERED:
                dead_tokens.add(row.expo_token)
            else:
                self.stderr.write(
                    f"Push {ticket_id} failed after acceptance: "
                    f"{receipt.get('message', error or 'unknown error')}"
                )

        reaped = 0
        if dead_tokens:
            reaped, _ = DevicePushToken.objects.filter(
                expo_token__in=dead_tokens
            ).delete()
        if settled:
            PushReceipt.objects.filter(pk__in=settled).delete()

        self.stdout.write(
            f"Checked {len(settled)} receipt(s); reaped {reaped} dead device(s)."
        )

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
