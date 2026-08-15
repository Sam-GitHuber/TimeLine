"""Drain the push outbox: send queued notifications to Expo (Phase 9, D).

Run out-of-band, never from a web request — see ``PushOutbox`` for why.

**Two ways to run it.** ``--loop`` is the production one (issue #354): a resident
process that starts Django once and sweeps the outbox every couple of seconds,
run as the ``pushes`` service in the compose stack. Without it the command does
exactly one pass and exits, which is what a hand-run and every test does, and
what the retired ``deploy/send-pushes.timer`` used to do once a minute.

The flow per drain:

1. Take the oldest unsent rows that haven't exhausted their retries, locking
   them so a hand-run and the resident drain can't send the same push twice.
2. Resolve each recipient's *current* device tokens (looked up now, not at
   enqueue time, so a rotated token still gets the push), skipping any device
   this row has already reached.
3. Build one Expo message per (row × outstanding device) and POST in batches.
   A **message** row is dropped here instead if the recipient has since read the
   thread (``_should_drop``), or left queued for a later run if it is so fresh
   that they have not had a chance to say so yet (``_should_defer``) or if they
   were buzzed about this same thread moments ago (``_should_space_out``).
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
import signal
import threading
import time
import urllib.parse
import urllib.request
from datetime import timedelta

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import close_old_connections, transaction
from django.db.models import Max, Q
from django.utils import timezone

from ...models import (
    ConversationRead,
    DevicePushToken,
    MessageMention,
    PushOutbox,
    PushReceipt,
)
from ...notifications import (
    ANONYMOUS_MESSAGE_BODY,
    MENTION_CHANNEL,
    channel_for_kind,
    is_mentioned,
    message_push_body,
)
from ...serializers import NotificationSerializer
from ...views import badge_count_for

# Expo's reply carries one ticket per message, in the order sent.
_DEVICE_NOT_REGISTERED = "DeviceNotRegistered"

# How long ``--loop`` waits after an iteration raised before trying again.
#
# The whole point of a resident drain is that it survives things a oneshot could
# just exit on — a Postgres restart, a network blip — so an exception cannot be
# allowed to kill the process. But it equally cannot be allowed to spin: a
# database that is down stays down for seconds at least, and retrying every two
# seconds would fill the log faster than anyone could read it. Ten seconds is
# long enough to be quiet and short enough that recovery is not something you
# wait for.
_LOOP_ERROR_BACKOFF_SECONDS = 10


class Command(BaseCommand):
    help = "Send queued push notifications to Expo's push service."

    # How many message pushes the last drain held back, for the loop's
    # heartbeat to report. A count rather than a line per row per pass: a row
    # held for the full cooldown spans thirty drains.
    _last_deferred = 0

    # **Two independent axes, deliberately.** `verbosity` is Django's own
    # "how much do you want to hear" (0 = nothing), and applies to both modes.
    # `quiet_when_idle` is about *which* lines make sense in a resident process
    # rather than how many: at a two-second cadence "Nothing queued." is 43,000
    # lines a day saying nothing happened, which is how a log stops being read,
    # while "Sent 1" must keep printing because the container log is the only
    # record there is. Collapsing them (`--loop` implying `-v0`) would silence
    # the half that matters. Class attributes so `_drain` still works when a
    # test or a shell calls it directly.
    verbosity = 1
    quiet_when_idle = False

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
        parser.add_argument(
            "--loop",
            action="store_true",
            help=(
                "Stay resident and drain repeatedly (the production mode; see "
                "the `pushes` service in docker-compose.prod.yml). Without it "
                "the command makes exactly one pass and exits."
            ),
        )
        parser.add_argument(
            "--interval",
            type=float,
            default=settings.PUSH_DRAIN_INTERVAL_SECONDS,
            help="Seconds between drains in --loop mode.",
        )
        parser.add_argument(
            "--maintenance-interval",
            type=float,
            default=settings.PUSH_MAINTENANCE_INTERVAL_SECONDS,
            help=(
                "Seconds between receipt checks and prunes in --loop mode. "
                "Deliberately much larger than --interval."
            ),
        )

    def handle(self, *args, **options):
        max_rows = options["max_rows"]
        dry_run = options["dry_run"]
        self.verbosity = options["verbosity"]

        if options["loop"]:
            if dry_run:
                # A dry run writes no state, so a looping one would print the
                # same rows for ever and never make progress. Refusing is
                # clearer than obeying.
                raise CommandError("--loop and --dry-run cannot be combined.")
            if options["interval"] <= 0:
                raise CommandError("--interval must be greater than zero.")
            if options["maintenance_interval"] <= 0:
                # Guarded for the same reason as --interval, though it fails
                # differently: 0 doesn't spin the CPU, it makes `started >=
                # next_maintenance` true on every pass, so the receipt check
                # fires an HTTP round-trip to Expo and the prune a full-table
                # DELETE every two seconds. That is ~43,000 Expo calls a day —
                # precisely the waste the two-cadence split exists to avoid —
                # and nothing about the symptom would point at this setting.
                raise CommandError(
                    "--maintenance-interval must be greater than zero; it is "
                    "meant to be much larger than --interval."
                )
            self._run_loop(
                max_rows,
                interval=options["interval"],
                maintenance_interval=options["maintenance_interval"],
            )
            return

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

    def _run_loop(self, max_rows, *, interval, maintenance_interval):
        """Stay resident, draining every ``interval`` seconds (issue #354).

        **Why resident rather than a faster timer.** The old
        ``send-pushes.timer`` fired ``docker compose exec … manage.py
        send_pushes`` once a minute, and every tick paid for a cold Django
        process. Tightening *that* to two seconds would have meant 43,000
        interpreter startups a day on a 2 vCPU box, almost all of them to
        discover an empty queue. Starting Django once and asking again in a loop
        makes an idle sweep one indexed ``SELECT`` — measured at ~7ms against
        ~740ms for a cold oneshot — so this is both far quicker *and* cheaper at
        rest than the timer it replaces, despite running 30× as often. The
        figures and the method are in docs/reference/notifications.md.

        **The two cadences are the point.** ``handle`` runs drain → receipts →
        prune together because at one pass a minute there is no reason not to.
        Here they must come apart: receipts are not even asked for until they are
        fifteen minutes old and pruning is daily work, so running either every
        two seconds would be pure waste. Only the drain goes fast.

        **They still run in one thread, in order.** A slow Expo can therefore
        stall a drain behind a receipt check — which is exactly what the oneshot
        did too, so it is not a regression, and it is self-limiting: an Expo slow
        enough to block the receipt call is an Expo the sends are queueing behind
        anyway. A second thread would buy a rare few seconds in exchange for a
        second database connection and a second set of transaction boundaries.

        **Losing systemd's overlap guard costs nothing.** It never started a
        second run while one was active; here there is only ever one loop. The
        real defence against double-sends was always ``_drain``'s
        ``select_for_update(skip_locked=True)``, which is untouched and is also
        what still makes a hand-run alongside this safe.
        """
        stop = threading.Event()

        def request_stop(signum, _frame):
            # Only ever set a flag. The current drain finishes and its
            # transaction commits, rather than being torn down partway through
            # an Expo call with rows claimed and no idea whether they were sent.
            # Restoring the default handler means a *second* signal — an
            # impatient Ctrl-C, or docker's SIGKILL chaser — still kills at once.
            signal.signal(signum, signal.SIG_DFL)
            stop.set()
            self._say("Stopping after this drain…")

        # Saved so they can go back on the way out. A dedicated container never
        # notices either way, but a command that permanently replaces the
        # process's SIGINT handler is rude to anything that runs it in-process —
        # a test suite, a shell, a future supervisor — and leaves Ctrl-C dead
        # afterwards.
        previous_handlers = {
            sig: signal.signal(sig, request_stop)
            for sig in (signal.SIGTERM, signal.SIGINT)
        }

        self.quiet_when_idle = True
        self._say(
            f"Draining every {interval}s, maintenance every "
            f"{maintenance_interval}s. SIGTERM to stop."
        )
        try:
            self._loop_until(
                stop,
                max_rows,
                interval=interval,
                maintenance_interval=maintenance_interval,
            )
        finally:
            for sig, handler in previous_handlers.items():
                signal.signal(sig, handler)
        self._say("Stopped.")

    def _loop_until(self, stop, max_rows, *, interval, maintenance_interval):
        """The loop body proper — split out only so ``_run_loop`` can put the
        signal handlers back however this returns."""

        # `None` rather than 0: maintenance runs on the very first pass, so a
        # restart doesn't leave receipts unchecked for a minute.
        next_maintenance = None
        drains = 0
        while not stop.is_set():
            # Timed from the *start* of the pass, so the cadence is "every two
            # seconds" and not "two seconds after the last one finished" —
            # otherwise a slow drain quietly stretches the interval it was
            # supposed to hold.
            started = time.monotonic()
            try:
                with transaction.atomic():
                    self._drain(max_rows, dry_run=False)
                drains += 1
            except Exception as exc:
                # A resident drain that dies on a transient fault is worse than
                # the timer it replaced, which at least got a fresh process next
                # minute. So: log it, drop the database connection so the next
                # pass reconnects rather than reusing a socket Postgres has
                # already closed, and back off enough not to spin.
                self.stderr.write(f"Drain failed: {exc}")
                close_old_connections()
                stop.wait(_LOOP_ERROR_BACKOFF_SECONDS)
                continue

            if next_maintenance is None or started >= next_maintenance:
                # **Advanced before the work, not after.** Assigning this
                # afterwards means a maintenance step that keeps failing is
                # retried on *every* pass rather than every minute — so a stuck
                # prune would fire Expo's getReceipts endpoint at drain cadence,
                # which is the exact waste the two-cadence split exists to
                # prevent, arriving only when something is already wrong.
                next_maintenance = started + maintenance_interval
                try:
                    self._check_receipts(dry_run=False)
                    self._prune(dry_run=False)
                except Exception as exc:
                    # **Its own try, for the reason `handle` keeps these outside
                    # the drain's**: a receipts failure must not be reported as,
                    # or back off, a drain that actually succeeded. Sharing one
                    # handler made a stuck prune degrade push latency from 2s to
                    # the error backoff and log "Drain failed" for a drain that
                    # was fine — misdirecting exactly the person reading the log
                    # to find out why nothing is buzzing.
                    self.stderr.write(f"Maintenance failed: {exc}")
                    close_old_connections()
                # Outside that try on purpose: the heartbeat is what deploy.md
                # calls the alarm, and a maintenance fault is when you most need
                # to still be hearing it.
                self._heartbeat(drains)
                drains = 0

            stop.wait(max(0.0, interval - (time.monotonic() - started)))

    def _heartbeat(self, drains):
        """One line per maintenance tick saying the loop is alive.

        Without it a healthy quiet stretch and a wedged process produce exactly
        the same output — nothing — and the failure mode to recognise is "no
        phone ever buzzes", which looks like silence either way.
        """
        held = self._last_deferred
        line = f"Alive: {drains} drain(s) since the last report"
        if held:
            line += f", {held} message push(es) currently held back"
        self._say(f"{line}.")

    def _say(self, message):
        """Ordinary output, gated on Django's ``--verbosity``.

        The command used to write to ``self.stdout`` unconditionally, so
        ``-v0`` did nothing — including for the test suite, which passes it
        and then printed a send line per case anyway. **Errors deliberately
        do not go through here**: ``-v0`` asks for quiet, not for a failed
        drain to become invisible.
        """
        if self.verbosity >= 1:
            self.stdout.write(message)

    def _note_idle(self, message):
        """Say something a resident loop would otherwise repeat verbatim.

        These lines describe a *state* rather than an event — nothing queued,
        nothing outstanding, N rows still held — so they stay true across passes
        and a two-second loop would print each one thousands of times for a
        single unchanging fact. Printed by a oneshot run, where the output is a
        report someone asked for and read; folded into the heartbeat in
        ``--loop``. Lines that describe work actually done (``Sent 1, requeued
        0.``) go straight to stdout on both paths.
        """
        if not self.quiet_when_idle:
            self._say(message)

    def _drain(self, max_rows, *, dry_run):
        rows = PushOutbox.objects.filter(
            sent_at__isnull=True,
            attempts__lt=PushOutbox.MAX_ATTEMPTS,
        ).select_related(
            # The icon-badge count is per *recipient* (issue #179), so the drain
            # needs the user object, not just its id. Joined here rather than
            # fetched per row.
            "recipient",
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

        # `id` breaks ties on `created_at`, which is only microsecond-resolution
        # and is set by a single `bulk_create` for every recipient of a group
        # message — so ties are the normal case there, not a rarity. Without it
        # the `[:max_rows]` slice could take a different subset of a tied group
        # on each run, i.e. whose push goes out this drain and whose waits would
        # be arbitrary. Same reasoning as the device ordering below.
        pending = list(rows.order_by("created_at", "id")[:max_rows])
        if not pending:
            # **The whole of an idle sweep**: one indexed query and out, before
            # any of the per-batch lookups below. That early return is what makes
            # `--loop` cheaper at rest than the per-minute timer despite running
            # 30× as often, so keep new per-batch work below this line.
            self._last_deferred = 0
            self._note_idle("Nothing queued.")
            return

        # One query for every recipient's devices, rather than one per row.
        #
        # **Ordered, and that is not cosmetic.** This list decides the order
        # messages go into the batch, and `_send` matches Expo's reply back onto
        # them *positionally* (`zip(chunk, tickets, strict=True)`) — so which
        # device is credited with which ticket, which one a partial failure
        # leaves outstanding, and which straddle a chunk boundary all follow
        # from it. Unordered, Postgres is free to return whatever physical heap
        # order it currently has, which shifts as rows are inserted and deleted
        # over a table's life; the drain then behaves differently run to run for
        # reasons nothing in the code expresses. It surfaced as a CI-only
        # failure of the partial-multi-device test, which is the mild version —
        # the same non-determinism is what makes a production report of "the
        # wrong device got retried" impossible to reproduce.
        recipient_ids = {row.recipient_id for row in pending}
        devices_by_user = {}
        for device in DevicePushToken.objects.filter(
            user_id__in=recipient_ids
        ).order_by("id"):
            devices_by_user.setdefault(device.user_id, []).append(device)

        read_markers = self._read_markers(pending)
        # Both of these feed `_should_space_out` and nothing else, so switching
        # the cooldown off (the documented `PUSH_MESSAGE_COOLDOWN_SECONDS=0`
        # path) should not still pay for two grouped queries on every drain —
        # which at a 2s cadence is 30 a minute for a feature that is disabled.
        if settings.PUSH_MESSAGE_COOLDOWN_SECONDS > 0:
            last_pushes = self._last_pushes(pending)
            mention_marks = self._mention_marks(pending)
        else:
            last_pushes = mention_marks = {}
        # recipient_id → icon-badge count, filled in on demand by `_badge`.
        badges = {}

        messages = []
        deferred = 0
        # Rows this pass settles *without* calling Expo — no device, deleted
        # since enqueue, or already read. Counted because settling is real work
        # that writes `sent_at`, and it used to be reported only through the
        # "nothing outstanding to send" line, which `--loop` swallows as idle.
        # A drain that silently binned every queued push then looked exactly
        # like an empty queue, and "nobody's phone buzzes" is the symptom of
        # both — so a `_should_drop` gone wrong (a read-marker bug, clock skew)
        # would have been invisible in the one log there is.
        settled = 0
        # One clock for the whole pass, so every row in a batch is judged
        # against the same instant rather than drifting apart as it runs.
        now = timezone.now()
        for row in pending:
            # Two reasons to drop a message push rather than send it, both
            # settled (not retried) because neither state is ever undone: the
            # message has since been deleted, or the recipient has already read
            # it. See _should_drop.
            if row.message_id and self._should_drop(row, read_markers):
                settled += 1
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
                settled += 1
                if not dry_run:
                    row.sent_at = timezone.now()
                    row.save(update_fields=["sent_at"])
                continue
            # Two reasons to hold a message push rather than send it now: the
            # recipient may be about to tell us they've read it (_should_defer),
            # or they were buzzed about this thread moments ago
            # (_should_space_out). Both leave the row **untouched** — no
            # `sent_at`, no `attempts` — because this is "ask again shortly", not
            # a failure: spending an attempt here would let a chatty thread
            # exhaust MAX_ATTEMPTS without Expo ever having been called.
            #
            # **Below the device check on purpose.** There is nothing to protect
            # a recipient with no registered device from — no phone will buzz
            # either way — so deferring one would leave a row queued for a drain
            # that can never send it, and (because `enqueue_message_pushes`
            # coalesces onto any unsent row) suppress the *next* message's row
            # behind it.
            if row.message_id and (
                self._should_defer(row, read_markers, now)
                or self._should_space_out(row, last_pushes, mention_marks, now)
            ):
                deferred += 1
                continue
            payload = self._payload(row)
            badge = self._badge(row, badges)
            for device in outstanding:
                messages.append(
                    (row, device, self._message(device, payload, badge))
                )

        # Reported on **every** path, not just the empty one. A held row is a
        # fourth outcome beside sent/settled/requeued, and a drain that also has
        # something to send is the usual case — so leaving it off the busy path
        # would make a misconfigured grace look like a perfectly healthy drain
        # while nobody's phone buzzed. See _should_defer.
        #
        # In `--loop` it goes through `_note_idle` and out to the heartbeat
        # instead: a row held for the full cooldown spans thirty drains, and
        # thirty identical lines describe one event, not thirty.
        self._last_deferred = deferred
        if deferred:
            self._note_idle(f"{deferred} message push(es) held back.")

        # Through `_say`, not `_note_idle`: this describes rows whose state
        # changed, so it belongs in the resident log next to "Sent N".
        if settled:
            self._say(
                f"Settled {settled} row(s) without sending "
                "(no device, deleted, or already read)."
            )

        if not messages:
            self._note_idle(
                f"{len(pending)} queued, nothing outstanding to send."
            )
            return

        if dry_run:
            for _row, device, message in messages:
                self._say(f"→ {device.expo_token[:20]}… {message['body']}")
            self._say(f"Dry run: {len(messages)} message(s) not sent.")
            return

        self._send(messages)

    def _message_pairs(self, pending, conversation_field, user_field):
        """OR one ``(conversation, recipient)`` predicate per message row in this
        batch, or ``None`` if the batch has no message rows.

        Three lookups need the same shape — ``_read_markers``,
        ``_last_pushes``, ``_mention_marks`` — and differ only in what the two
        columns are called from where they start. They were three copies of this
        loop until the third one made that obvious.

        ``Q(pk__in=[])`` is the identity to OR onto: a predicate matching
        nothing, so the chain says exactly "any of these pairs" even for one row.

        One query per lookup rather than one per row is the whole point; the
        pending list is capped at ``EXPO_PUSH_MAX_ROWS``, so the OR-chain has a
        known ceiling.
        """
        wanted = [row for row in pending if row.message_id]
        if not wanted:
            return None
        pairs = Q(pk__in=[])
        for row in wanted:
            pairs |= Q(
                **{
                    conversation_field: row.message.conversation_id,
                    user_field: row.recipient_id,
                }
            )
        return pairs

    def _read_markers(self, pending):
        """``{(conversation_id, user_id): last_read_at}`` for the message rows in
        this batch — one query for the lot rather than one per row."""
        pairs = self._message_pairs(pending, "conversation_id", "user_id")
        if pairs is None:
            return {}
        return {
            (read.conversation_id, read.user_id): read.last_read_at
            for read in ConversationRead.objects.filter(pairs)
        }

    def _last_pushes(self, pending):
        """``{(conversation_id, user_id): sent_at}`` — when each recipient in
        this batch was last *actually buzzed* about each thread.

        Read by ``_should_space_out``. One grouped query for the batch, in the
        same shape and for the same reason as ``_read_markers``.

        **``sent_at`` alone is the wrong question**, which is the trap here.
        ``_drain`` stamps it on rows it settles without calling Expo at all — a
        recipient with no devices, a message deleted since enqueue, a push
        dropped because they'd already read it. Treating those as a buzz would
        let a *silent* row start a minute of cooldown, and the commonest of them
        (dropped-as-read) fires precisely for the people in a live conversation,
        so the mistake would fall hardest on exactly the exchanges that must stay
        quick. ``delivered_tokens`` is the honest record: it is non-empty only
        once Expo accepted the message for a device.
        """
        pairs = self._message_pairs(
            pending, "message__conversation_id", "recipient_id"
        )
        if pairs is None:
            return {}
        grouped = (
            PushOutbox.objects.filter(pairs, sent_at__isnull=False)
            .exclude(delivered_tokens=[])
            .values("message__conversation_id", "recipient_id")
            .annotate(last_sent=Max("sent_at"))
        )
        return {
            (entry["message__conversation_id"], entry["recipient_id"]): entry[
                "last_sent"
            ]
            for entry in grouped
        }

    def _mention_marks(self, pending):
        """``{(conversation_id, user_id): newest_mention_time}`` for the message
        rows in this batch.

        Read by ``_should_space_out`` to answer "has this person been named in
        this thread since the message their queued push points at?" — which is
        the question the cooldown's @mention exemption actually needs, because a
        row covers every message that coalesced onto it, not just its own.

        The **newest** mention is all that need be stored: the caller compares it
        against the row's own message time, and if the most recent mention is
        older than that, no later one exists to find.

        Soft-deleted messages are excluded. A mention taken back should not go on
        punching a push through the cooldown, and ``_should_drop`` already treats
        a deleted message as a reason not to send at all.
        """
        pairs = self._message_pairs(
            pending, "message__conversation_id", "user_id"
        )
        if pairs is None:
            return {}
        grouped = (
            MessageMention.objects.filter(pairs, message__deleted_at__isnull=True)
            .values("message__conversation_id", "user_id")
            .annotate(newest=Max("message__created_at"))
        )
        return {
            (entry["message__conversation_id"], entry["user_id"]): entry["newest"]
            for entry in grouped
        }

    def _badge(self, row, cache):
        """The number to put on this recipient's **app icon** (issue #179).

        Cached per recipient for the batch, because the count is a property of
        the *recipient* and not of the row. **A group message is not the case
        this helps** — it queues one row per member, and those are twenty
        different people, so it's twenty counts either way. What it catches is
        one person holding several rows at once: a message in one thread and a
        reaction on a post, two threads busy at the same time, or a retry
        backlog. That's cheaper, and it's also the only way every push in a
        drain can *agree* on the number rather than two arriving milliseconds
        apart disagreeing.

        Counted *now* rather than at enqueue time, and deliberately so: the row
        may have sat in the queue for a tick or two, and what belongs on the
        icon is what's waiting when the push lands, not what was waiting when it
        was written. That's also why it includes the message this push is
        about — it's unread by definition at this point.

        It is **not free** — ``badge_count_for`` runs a query per conversation,
        the same family-scale trade-off ``UnreadMessageCountView`` makes. The
        cache is what keeps that from multiplying by the batch size.
        """
        if row.recipient_id not in cache:
            cache[row.recipient_id] = badge_count_for(row.recipient)
        return cache[row.recipient_id]

    def _should_drop(self, row, read_markers):
        """Whether this queued *message* push should be dropped instead of sent.

        **Deleted since enqueue.** Message deletion is a *soft* delete — the row
        stays as a tombstone so the thread doesn't reshuffle — so unlike the
        notification path there's no cascade to take the queued push with it.
        Without this check, deleting a message you regret still buzzes everyone
        up to a drain later, and the tap lands on "message deleted". The
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

    def _should_defer(self, row, read_markers, now):
        """Whether this *message* push should be left queued a little longer
        (issue #355).

        **The problem it solves.** ``_should_drop`` above asks whether the
        recipient has already read the message, and that question is only
        answerable once their client has *told* us. A client cannot do that
        until its own poll (``MESSAGE_POLL_MS``, 4s) has delivered the message —
        so for the first few seconds of a message's life, "have they read it?"
        reliably answers *no* for someone staring straight at it. A drain landing
        in that window buzzes a phone for a message already on its screen.

        Nothing protected us from that except the drain being slow: a
        once-a-minute timer landed inside a 4s window about one message in
        fifteen. That was not a design, it was a coincidence — and #354 has since
        removed it. **At today's two-second cadence the drain beats the poll
        every time, so this method is now the only thing standing between a
        reader and a pointless buzz.** It was written in anticipation of that and
        is now load-bearing.

        **Why it is conditional.** Waiting is only ever right for someone who
        might be about to say "I've seen it". Applying it to everyone would put a
        floor under every push, including the case push actually exists for — a
        phone in a pocket, where nobody is going to mark anything read and the
        grace would be pure delay. So it applies only when the recipient's read
        marker for *this* thread moved within ``PUSH_ACTIVE_THREAD_SECONDS``,
        which is as close to "they're in this conversation right now" as the
        server can get without a presence system. No marker at all — they have
        never opened the thread — is emphatically not active.

        **What it costs — much less than it used to.** A deferred row waits for
        the next drain, which is now two seconds away rather than up to sixty, so
        the *most* this can delay a push is the grace itself: six seconds. The
        age test is what caps it, and the cap is why
        ``PUSH_ACTIVE_THREAD_SECONDS`` could be widened from 15s to 120s in the
        same change — a wide window used to mean minute-long holds and now means
        six-second ones, while a narrow one misses the silent reader whose marker
        hasn't moved because nothing has arrived to move it.

        **It cannot strand a row.** The age test is against the message's own
        ``created_at``, which doesn't move, so once a row is older than the grace
        no later run can defer it again however active the recipient looks.

        **Known limitation: "active" is broader than "reading".** The marker is
        also stamped when the recipient *sends* (``MessageCreateView`` —
        "sending implies you've read everything up to now") and when they swipe
        **Mark read** on the conversation list. So someone who fires off a reply
        and pockets the phone looks active for the next
        ``PUSH_ACTIVE_THREAD_SECONDS``, and a reply arriving in that window is
        held. This used to be the argument for keeping the window small; with a
        resident drain it is bounded by the grace at six seconds, which is why
        the window could stop paying for it. The alternative — telling the three
        apart — needs a presence signal this deliberately avoids.

        This deliberately does **not** try to answer "is the thread on screen".
        That needs a presence signal from the client, and the whole point of
        leaning on ``ConversationRead`` is that it is state the app already
        maintains for its own reasons.
        """
        grace = timedelta(seconds=settings.PUSH_MESSAGE_GRACE_SECONDS)
        if now - row.message.created_at >= grace:
            return False
        marker = read_markers.get(
            (row.message.conversation_id, row.recipient_id)
        )
        if marker is None:
            return False
        active = timedelta(seconds=settings.PUSH_ACTIVE_THREAD_SECONDS)
        return now - marker < active

    def _should_space_out(self, row, last_pushes, mention_marks, now):
        """Whether this *message* push is too soon after the last one we sent the
        same person about the same thread (issue #354).

        **This is not a new policy. It is an old one that used to be free.**
        ``enqueue_message_pushes`` coalesces: if a recipient already has an
        unsent push queued for a conversation, a further message doesn't add
        another row, because "a burst of ten messages should buzz a phone once
        and leave the unread badge to carry the count". But that only ever
        worked because a row *sat* unsent — up to a minute, on the old timer.
        The property the app actually shipped was **at most one message buzz per
        person per thread per drain interval**, and nobody wrote it down because
        the drain interval was sixty seconds and it looked like the coalescing
        doing the work.

        Make the drain resident at two seconds and the same coalescing code
        permits thirty buzzes a minute. Nothing in the enqueue changed; the thing
        holding it up was removed. So the guarantee is restated here explicitly,
        at the value the timer used to give it
        (``PUSH_MESSAGE_COOLDOWN_SECONDS``, 60s).

        **Held, not dropped.** The row goes out when the cooldown expires. That
        matches what the old timer did with the row left over after a coalesced
        burst — a second buzz, up to a minute later — and it means a thread
        nobody is reading still nudges again rather than falling silent after one
        push. It also cannot strand a row: ``last_sent`` belongs to an
        already-sent row and never moves, and no *other* push for the pair can
        overtake it, since it is held by this same rule.

        **@mentions are exempt**, for the same reason they are exempt from mute
        (Phase 9b M8): naming someone is how you get their attention, and being
        named in a busy thread is the case where a minute's silence is most
        obviously wrong. It is also the case the cooldown would otherwise hurt
        most, because a busy thread is what puts you in cooldown — which is why
        the exemption has to look at every message the row stands for, not just
        the one it points at. See ``_mention_marks``.
        """
        cooldown = timedelta(seconds=settings.PUSH_MESSAGE_COOLDOWN_SECONDS)
        if cooldown <= timedelta(0):
            return False
        key = (row.message.conversation_id, row.recipient_id)
        # **Not ``is_mentioned(row.message, …)``.** A queued row keeps pointing
        # at the message it was created for while later ones coalesce onto it
        # (see the NB in ``enqueue_message_pushes``), so asking its own message
        # answers about the *first* message of the burst. An @mention arriving
        # mid-burst creates no row of its own and would be held the full
        # cooldown — in a busy thread, which is the only place a row is reliably
        # already queued, and therefore in exactly the case the exemption was
        # written for. ``_mention_marks`` asks about everything the row now
        # stands for instead.
        mentioned_at = mention_marks.get(key)
        if mentioned_at is not None and mentioned_at >= row.message.created_at:
            return False
        last_sent = last_pushes.get(key)
        return last_sent is not None and now - last_sent < cooldown

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
                "channel": channel_for_kind(data["kind"]),
            }

        message = row.message
        convo = message.conversation
        # sender is a non-null CASCADE FK, so a deleted account takes its
        # messages (and these rows) with it — no "Someone" fallback needed here,
        # unlike a Notification's actor, which is SET_NULL on purpose.
        #
        # The wording lives in ``notifications.message_push_body`` rather than
        # here, because Phase 10b's preview endpoint has to compose the *same*
        # four branches with the message text appended. It replaces this body on
        # the device, so a second copy of the phrasing would drift the moment
        # either side grew a branch.
        text = message_push_body(message, row.recipient_id)
        # The same predicate the wording used, from the same helper: a body
        # reading "Ada mentioned you" that arrives on the messages channel is
        # the precise failure the mentions channel exists to prevent.
        mentioned = is_mentioned(message, row.recipient_id)
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
            # A mention gets the **mentions** channel, not messages. Without
            # this the channel is unreachable — `Kind.MENTION` never creates a
            # `Notification`, so a mention always rides this message branch —
            # and someone who turns Messages down to quieten a busy group chat
            # silences their @mentions with it. Which is the exact outcome the
            # separate channel exists to prevent.
            "channel": MENTION_CHANNEL if mentioned else channel_for_kind("message"),
            # This push has something a device could fetch a preview *for*
            # (Phase 10b) — set on the message branch and nowhere else.
            #
            # It is what ``_message`` gates ``mutableContent`` on, and the gate
            # has to be the payload rather than the device alone. Gate on the
            # device only and the first *notification* push to a preview-enabled
            # device reads a key this branch never sets: a ``KeyError`` inside
            # ``_drain``'s transaction, rolling back the whole drain and taking
            # the receipt check and prune with it — all push delivery stops,
            # every tick, until someone notices. Gate loosely with ``.get()`` on
            # a key both branches set and you wake the extension for "Ada
            # reacted to your post", which has no preview to fetch and is
            # explicitly not what this feature is for.
            "previewable": True,
        }

    def _message(self, device, data, badge):
        """One Expo push message from a payload.

        Deliberately carries **no post, comment or message content** — only the
        server-phrased line ("Ada replied to your post", "New message from Ada").
        The body transits Expo's servers and Apple's, so it names people but
        never quotes them. That rule is what lets message pushes exist at all: a
        private message's *text* never leaves our infrastructure.

        ``data`` is what the app reads on tap to deep-link: ``url`` is the same
        route string the web app uses (e.g. ``/p/12?comment=34``), which the app
        maps onto its native route.

        ``badge`` is the icon count (issue #179). A number, never omitted and
        never ``None``: this is the only lever that can set an icon badge on a
        phone that isn't running the app, so it has to be on every push,
        including the one that brings the count back to zero. Expo maps it to
        APNs' ``aps.badge`` and it is **iOS-only** — Android gets no equivalent
        field, which is why the app's own badge calls are iOS-only too (see
        ``push.ts``).
        """
        message = {
            "to": device.expo_token,
            "title": "TimeLine",
            "body": data["text"],
            "sound": "default",
            "badge": badge,
            "data": {
                "notificationId": data["id"],
                "kind": data["kind"],
                "url": data["url"],
            },
        }
        # **A device with previews off gets an anonymous body, and no Reply.**
        #
        # The setting governs both halves of what a notification discloses: who
        # it is from, and what they said. Leaving the sender's name on while
        # withholding the text would be a strange half-privacy — it is the
        # correspondent, more than the words, that a glance at a lock screen
        # gives away.
        #
        # It also improves what leaves the box, which is the one privacy gain in
        # this phase that isn't about a lock screen at all: this body is what
        # Expo and Apple/Google see, and an anonymous one is a body they cannot
        # read a correspondent's name out of.
        #
        # **Reply goes with it**, reversing the rule this phase started with
        # ("previews off gets exactly today's behaviour, Reply included"). That
        # held while off still named the sender. Once it doesn't, a reply field
        # answers an unknown message from an unknown person — the trap this
        # phase exists to fix, in a worse form than the one it started with.
        #
        # Gated on ``previewable`` so it touches message pushes only. "Ada
        # reacted to your post" names a person and is not a message preview;
        # anonymising it is a different setting, and the phase's non-goals say
        # so.
        anonymous = data.get("previewable") and not device.show_previews
        if anonymous:
            message["body"] = ANONYMOUS_MESSAGE_BODY

        # Expo's field name for APNs' ``category``. Sent only where there's an
        # action to offer, so a notification kind that grows one later opts in
        # by adding it to its payload rather than by changing this.
        if data.get("category") and not anonymous:
            message["categoryId"] = data["category"]
        # The Android notification channel (Phase 10). Ignored by iOS, and
        # **required** on Android: a push naming a channel the device doesn't
        # have is dropped silently rather than falling back to a default, so
        # these ids must match the app's. See ``notifications.channel_for_kind``.
        if data.get("channel"):
            message["channelId"] = data["channel"]
        # APNs' ``mutable-content``, which is what wakes the iOS notification
        # service extension so it can replace the body with the actual message
        # (Phase 10b). **Both gates are load-bearing.** The payload one keeps it
        # off every non-message push — see ``previewable`` in ``_payload`` for
        # what gating on the device alone would cost. The device one is the
        # user's own choice, read per device because what leaks is a lock
        # screen: ``_message`` already runs once per device, so this costs
        # nothing to honour here.
        #
        # Note what this does *not* do: it adds no content to the push. The body
        # on the wire is still the contentless line composed above, and it stays
        # there as the fallback for every way the extension can fail to run —
        # which is why the push is never sent silent. The one thing that does
        # leave the box is the flag itself: its presence tells Expo and Apple
        # that this device has previews on. A privacy setting's *value*, not any
        # content, and the honest disclosure is in notifications.md.
        #
        # **iOS only, for now.** ``mutable-content`` is an APNs field; FCM has
        # no equivalent, so on Android it wakes nothing and fetches nothing —
        # all it would do is make the disclosure above for no benefit at all.
        # Android's rewrite path is M4, and it may not land; if it does, this
        # gate is where it opts in.
        if (
            data.get("previewable")
            and device.show_previews
            and device.platform == DevicePushToken.Platform.IOS
        ):
            message["mutableContent"] = True
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
                    # Counts as settled, not failed — retrying can't help, and
                    # touching `outcome` at all is what settles the row: no
                    # errors recorded means `sent_at` is stamped below.
                    device.delete()
                    # **Deliberately NOT added to `delivered_tokens`** (issue
                    # #354). That list means "a phone was reached", and
                    # `_last_pushes` reads exactly that to decide whether a
                    # cooldown has started. A token we have just discovered was
                    # dead buzzed nobody, so recording it would silence the
                    # recipient's *next* message for a minute on the strength of
                    # a push that never rang — and the moment this fires is a
                    # reinstall or a token rotation, i.e. precisely when they
                    # have a working device again. Skipping the entry is safe
                    # because its only other job is stopping a retry re-buzzing
                    # a device, and this device no longer exists.
                    outcome(row)
                    continue

                outcome(row)["errors"].append(
                    ticket.get("message", "unknown error")
                )

        sent = requeued = 0
        # How long the rows in this batch waited between being enqueued and
        # going to Expo — **our** half of push latency, which is the only half we
        # can do anything about (issue #354). Reported because the alternative is
        # guessing: Expo → APNs/FCM → device adds 1-5s nobody here can see, so
        # "is the delay ours?" is unanswerable without this number, and it is the
        # number that says whether tuning the drain interval further would
        # achieve anything at all. The worst wait rather than the mean: a batch's
        # slowest row is the one a person notices.
        waits = []
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
                waits.append((row.sent_at - row.created_at).total_seconds())
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

        summary = f"Sent {sent}, requeued {requeued}"
        if waits:
            summary += f" (queued up to {max(waits):.1f}s)"
        self._say(f"{summary}.")

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
            self._say(
                f"Would check {ready.count()} receipt(s), "
                f"expire {expired.count()}."
            )
            return

        expired_count, _ = expired.delete()
        if expired_count:
            self._say(
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

        self._say(
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
            self._say(f"Would prune {stale.count()} row(s).")
            return
        deleted, _ = stale.delete()
        if deleted:
            self._say(f"Pruned {deleted} row(s).")
