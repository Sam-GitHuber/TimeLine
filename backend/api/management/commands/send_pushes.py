"""Drain the push outbox: send queued notifications to Expo (Phase 9, D).

Run on a systemd timer (``deploy/send-pushes.timer``), not from a web request —
see ``PushOutbox`` for why the send is out-of-band.

The flow per drain:

1. Take the oldest unsent rows that haven't exhausted their retries, locking
   them so a hand-run and a timer tick can't send the same push twice.
2. Resolve each recipient's *current* device tokens (looked up now, not at
   enqueue time, so a rotated token still gets the push), skipping any device
   this row has already reached.
3. Build one Expo message per (row × outstanding device) and POST in batches.
   A **message** row is dropped here instead if the recipient has since read the
   thread — see ``_message_body``.
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

A **message** push also carries a **category** (Phase 9b M8), which is what
gives it a Reply field when it's pulled down on iOS. The reply itself comes back
through the ordinary send endpoint from the app; nothing here receives it.

A **notification** row's wording and deep-link come straight from
``NotificationSerializer`` — the same ``text`` and ``url`` the web activity
centre renders, so a push and the in-app row can never drift apart. A
**message** row (issue #118) has no in-app row to agree with, so this command
phrases it, to the same rule every other push follows: name the person, never
quote them.
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

from ...models import ConversationRead, DevicePushToken, PushOutbox, PushReceipt
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
            # The message path reads the sender's name and the conversation's
            # title/kind to phrase its line.
            "message",
            "message__sender",
            "message__conversation",
        ).prefetch_related(
            # Whether *this* recipient was named decides the wording (Phase 9b
            # M8), and a muted thread's push is only here at all because they
            # were — so the line has to be able to say so.
            "message__mentions",
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
        recipient_ids = {row.recipient_id for row in pending}
        devices_by_user = {}
        for device in DevicePushToken.objects.filter(user_id__in=recipient_ids):
            devices_by_user.setdefault(device.user_id, []).append(device)

        read_markers = self._read_markers(pending)

        messages = []
        for row in pending:
            # Two reasons to drop a message push rather than send it, both
            # settled (not retried) because neither state is ever undone: the
            # message has since been deleted, or the recipient has already read
            # it. See _should_drop.
            if row.message_id and self._should_drop(row, read_markers):
                if not dry_run:
                    row.sent_at = timezone.now()
                    row.save(update_fields=["sent_at"])
                continue
            # Skip devices this row already reached on an earlier attempt, so a
            # retry never re-buzzes a phone that got it the first time.
            delivered = set(row.delivered_tokens or [])
            outstanding = [
                device
                for device in devices_by_user.get(row.recipient_id, [])
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
            payload = self._payload(row)
            for device in outstanding:
                messages.append((row, device, self._message(device, payload)))

        if not messages:
            self.stdout.write(f"{len(pending)} queued, nothing outstanding to send.")
            return

        if dry_run:
            for _row, device, message in messages:
                self.stdout.write(f"→ {device.expo_token[:20]}… {message['body']}")
            self.stdout.write(f"Dry run: {len(messages)} message(s) not sent.")
            return

        self._send(messages)

    def _read_markers(self, pending):
        """``{(conversation_id, user_id): last_read_at}`` for the message rows in
        this batch — one query for the lot rather than one per row."""
        wanted = [row for row in pending if row.message_id]
        if not wanted:
            return {}
        pairs = Q(pk__in=[])
        for row in wanted:
            pairs |= Q(
                conversation_id=row.message.conversation_id,
                user_id=row.recipient_id,
            )
        return {
            (read.conversation_id, read.user_id): read.last_read_at
            for read in ConversationRead.objects.filter(pairs)
        }

    def _should_drop(self, row, read_markers):
        """Whether this queued *message* push should be dropped instead of sent.

        **Deleted since enqueue.** Message deletion is a *soft* delete — the row
        stays as a tombstone so the thread doesn't reshuffle — so unlike the
        notification path there's no cascade to take the queued push with it.
        Without this check, deleting a message you regret still buzzes everyone
        up to a timer tick later, and the tap lands on "message deleted". The
        cascade covers the hard-delete case (conversation → messages → pushes);
        this covers the soft one, so "a push for deleted content cannot fire"
        holds either way.

        **Already read.** This is what "don't buzz me for a thread I'm looking
        at" costs us: almost nothing. Because the send is out-of-band, by the
        time a drain runs, anyone with the thread open — on the web, or in the
        app — has polled and pushed their read marker past this message. So a
        plain comparison against ``ConversationRead`` covers the case without a
        presence system, a heartbeat, or the app having to tell us anything. It
        also cleans up after a delayed drain: a message read on another device
        before the timer fired doesn't buzz the phone in your pocket.
        """
        if row.message.deleted_at is not None:
            return True
        marker = read_markers.get(
            (row.message.conversation_id, row.recipient_id)
        )
        return marker is not None and marker >= row.message.created_at

    def _payload(self, row):
        """The ``(text, url, kind, id)`` a push is built from, for either target.

        A notification defers entirely to ``NotificationSerializer`` so the phone
        and the activity centre read identically. A message has no in-app row to
        match, so it's phrased here.
        """
        if row.notification_id:
            data = NotificationSerializer(row.notification).data
            return {
                "id": data["id"],
                "kind": data["kind"],
                "text": data["text"],
                "url": data["url"],
            }

        message = row.message
        convo = message.conversation
        # sender is a non-null CASCADE FK, so a deleted account takes its
        # messages (and these rows) with it — no "Someone" fallback needed here,
        # unlike a Notification's actor, which is SET_NULL on purpose.
        sender = message.sender.display_name
        # A photo says so (Phase 9b M7). It names the sender and the medium and
        # nothing else — the same rule as every other push body here, which is
        # why this one needed no new thinking: "sent a photo" is no more
        # revealing than "sent a message", and it's more useful, because knowing
        # a picture is waiting is often the whole reason to open the app.
        #
        # Said whenever there's an attachment, caption or not: the photo is the
        # notable thing, and a caption is content we wouldn't quote anyway.
        photo = message.attachments.exists()
        # Named with an @ (Phase 9b M8). Said first because it's the *reason*
        # this push exists whenever the thread is muted — a silenced chat that
        # suddenly buzzes owes you an explanation, and "Ada mentioned you" is it.
        # Still names the person and nothing else: a mention quotes no more of
        # the message than any other push body does.
        mentioned = any(
            mention.user_id == row.recipient_id
            for mention in message.mentions.all()
        )
        # A group thread says which one, since "New message from Ada" is
        # ambiguous when Ada is in four of your chats. An untitled group falls
        # back to the neutral phrasing rather than inventing a name.
        named_group = convo.kind == convo.Kind.GROUP and convo.title
        if mentioned:
            text = f"{sender} mentioned you"
            if named_group:
                text += f" in {convo.title}"
        elif photo:
            text = f"{sender} sent a photo"
            if named_group:
                text += f" in {convo.title}"
        elif named_group:
            text = f"{sender} in {convo.title}"
        else:
            text = f"New message from {sender}"
        return {
            # No notification id: there is no activity-centre row to mark read.
            # The app keys off `kind` to know that.
            "id": None,
            "kind": "message",
            "text": text,
            "url": f"/messages/{convo.id}",
            # The iOS notification category (Phase 9b M8), which is what puts a
            # **Reply** field on a pulled-down message push. Only messages carry
            # one: replying to "Ada replied to your post" would mean posting a
            # comment from the lock screen, which is a different feature and a
            # different endpoint. The name must match the app's
            # ``MESSAGE_CATEGORY`` — iOS ignores a category it doesn't know,
            # which looks exactly like the feature not existing.
            "category": "message",
        }

    def _message(self, device, data):
        """One Expo push message from a payload.

        Deliberately carries **no post, comment or message content** — only the
        server-phrased line ("Ada replied to your post", "New message from Ada").
        The body transits Expo's servers and Apple's, so it names people but
        never quotes them. That rule is what lets message pushes exist at all: a
        private message's *text* never leaves our infrastructure.

        ``data`` is what the app reads on tap to deep-link: ``url`` is the same
        route string the web app uses (e.g. ``/p/12?comment=34``), which the app
        maps onto its native route.
        """
        message = {
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
        # Expo's field name for APNs' ``category``. Sent only where there's an
        # action to offer, so a notification kind that grows one later opts in
        # by adding it to its payload rather than by changing this.
        if data.get("category"):
            message["categoryId"] = data["category"]
        return message

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
