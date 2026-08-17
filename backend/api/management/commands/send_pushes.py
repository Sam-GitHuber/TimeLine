"""Drain the push outbox: send queued notifications to Expo (Phase 9, D).

Run out-of-band, never from a web request — see ``PushOutbox`` for why.

**Two ways to run it.** ``--loop`` is the production one (issue #354): a resident
process that starts Django once and sweeps the outbox every couple of seconds,
run as the ``pushes`` service in the compose stack. Without it the command does
exactly one pass and exits, which is what a hand-run and every test does, and
what the retired ``deploy/send-pushes.timer`` used to do once a minute.

The flow per drain:

1. Take the oldest unsent rows that haven't exhausted their retries, locking
   them so a hand-run and the resident drain can't send the same push twice. A
   window filled by rows the drain then holds back is looked past rather than
   re-read on every tick — see ``_MAX_DRAIN_PAGES``.
2. Resolve each recipient's *current* device tokens (looked up now, not at
   enqueue time, so a rotated token still gets the push), skipping any device
   this row has already reached.
3. Build one Expo message per (row × outstanding device) and POST in batches.
   A **message** row is dropped here instead if the recipient has since read
   everything it stands for (``_should_drop``), or left queued for a later run
   if it is so fresh
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
from django.db.models import Exists, Max, OuterRef, Q
from django.utils import timezone

from ...models import (
    ConversationRead,
    DevicePushToken,
    Message,
    MessageMention,
    Participant,
    PushOutbox,
    PushReceipt,
    interval_spans,
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

# How many windows of ``--max-rows`` one drain will look at before giving up and
# waiting for the next tick.
#
# **Why more than one.** A held row (cooldown or read-grace) keeps
# ``sent_at IS NULL`` and its original ``created_at``, so it stays at the head of
# the ``[:max_rows]`` window it was selected in — and the cooldown holds it there
# for a *minute*, i.e. across thirty drains. Once a backlog of held rows fills a
# whole window, every drain would select the same held rows, send nothing, and
# starve everything queued behind them — including notification rows (a reply, a
# reaction, an invite), which are not subject to any hold and have no reason to
# wait. The old six-second read-grace could never squat a window for long enough
# to matter; a sixty-second cooldown can.
#
# So a drain that fills its window *and* holds something back takes another look
# past the rows it held. Bounded rather than "keep going until you find work"
# because a drain has to stay a predictable amount of work: the ceiling on rows
# examined is this times ``--max-rows``, and rows past it simply wait for the
# next tick two seconds later. `_drain` says so in the log when it stops here,
# because a silent cap reads exactly like an empty queue.
_MAX_DRAIN_PAGES = 3


class Command(BaseCommand):
    help = "Send queued push notifications to Expo's push service."

    # How many message pushes the last drain held back, for the loop's
    # heartbeat to report. A count rather than a line per row per pass: a row
    # held for the full cooldown spans thirty drains.
    _last_deferred = 0

    # Whether the last drain ran out of windows with rows still queued behind
    # held ones (see _MAX_DRAIN_PAGES). Carried to the heartbeat for the same
    # reason as the count above — it is a *state* that persists across drains,
    # so a line per pass would be thirty a minute describing one backlog.
    _last_capped = False

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
            #
            # **Nothing is printed from here, deliberately.** Python runs a
            # signal handler on the main thread between bytecodes, so a SIGTERM
            # landing while that thread is inside ``self.stdout.write`` would
            # re-enter the same ``BufferedWriter`` — whose lock is not
            # reentrant — and raise ``RuntimeError: reentrant call`` at whatever
            # line happened to be executing, quite possibly outside the loop's
            # own ``try``. That would kill the drain during precisely the
            # operation this handler exists to make safe. The loop says
            # "Stopped." itself once the flag is seen.
            signal.signal(signum, signal.SIG_DFL)
            stop.set()

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
                #
                # **The recovery itself is guarded**, because both halves of it
                # can throw: ``stderr.write`` raises ``BrokenPipeError`` if
                # whatever was consuming the log has gone away, and
                # ``close_old_connections`` re-raises whatever the driver raises
                # while tearing down a half-dead socket — which is exactly the
                # state the failure it is recovering from tends to leave. An
                # exception from either would escape this method entirely and
                # kill the process, i.e. the one thing this handler exists to
                # prevent, and would do it in precisely the circumstances that
                # brought us here.
                self._survive(f"Drain failed: {exc}")
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
                # **One try each, not one for the pair** — the same reason
                # `handle` keeps both outside the drain's, taken one step
                # further. A receipts failure must not be reported as, or back
                # off, a drain that actually succeeded (sharing the drain's
                # handler made a stuck prune degrade push latency to the error
                # backoff and log "Drain failed" for a drain that was fine); and
                # a receipts failure must not skip the prune either. Sharing one
                # handler between *these two* meant a receipt check that kept
                # raising — its Expo call is guarded internally, but its
                # ``delete()`` of expired receipts and dead tokens is not —
                # silently stopped the prune from ever running again, so the
                # outbox grew without bound while the site looked perfectly
                # healthy. That is worse here than it was in `handle`, where the
                # same exception at least ended the process loudly.
                for step in (self._check_receipts, self._prune):
                    try:
                        step(dry_run=False)
                    except Exception as exc:
                        self._survive(f"Maintenance failed: {exc}")
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
        if self._last_capped:
            # The one line here that says *do something*: a drain hitting the
            # window cap means rows are queued behind held ones for longer than
            # the two seconds this loop promises.
            line += ", and rows queued behind them are waiting"
        self._say(f"{line}.")

    def _survive(self, message):
        """Report a caught failure and reconnect, without ever raising.

        The loop's promise is that nothing short of a signal stops it, and the
        recovery path is the easiest place to break that promise: writing to a
        log nobody is reading any more raises ``BrokenPipeError``, and closing a
        connection whose socket is already gone re-raises the driver's error. An
        exception here would propagate out of the loop and end the process
        *while handling* the fault it was meant to survive.

        Swallowing an error while reporting an error is normally indefensible;
        it is the right trade only because the alternative is a dead drain and
        the symptom of a dead drain — nobody's phone buzzes — is the one this
        whole command is arranged to make visible.
        """
        try:
            self.stderr.write(message)
        except Exception:  # nosec B110 — see the docstring
            pass
        try:
            # A stale connection is the likeliest cause of whatever we just
            # caught, so the next pass must not reuse it.
            close_old_connections()
        except Exception:  # nosec B110 — see the docstring
            pass

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

        messages = []
        # recipient_id → icon-badge count, filled in on demand by `_badge`.
        badges = {}
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
        # Rows this drain has either settled or handed to Expo — the work
        # `--max-rows` actually bounds. **Held rows are deliberately not
        # counted**: holding one costs a comparison and changes nothing, and
        # counting it against the budget is exactly what let a window of held
        # rows stand in for a window of work. See _MAX_DRAIN_PAGES.
        acted = 0
        # Rows held back so far, so the next window can look *past* them instead
        # of selecting the same ones again.
        held_ids = []
        examined = 0
        # Set by the `for … else` below: every window this drain was allowed was
        # full and still holding rows back, so there is queued work it never
        # looked at.
        capped = False
        # One clock for the whole drain, so every row is judged against the same
        # instant rather than drifting apart as it runs — across windows too:
        # otherwise a row in the second window would be judged against a later
        # "now" than its neighbour in the first, for no reason anyone reading
        # the outcome could see.
        now = timezone.now()

        for window_number in range(_MAX_DRAIN_PAGES):
            # `id` breaks ties on `created_at`, which is only
            # microsecond-resolution and is set by a single `bulk_create` for
            # every recipient of a group message — so ties are the normal case
            # there, not a rarity. Without it the `[:max_rows]` slice could take
            # a different subset of a tied group on each run, i.e. whose push
            # goes out this drain and whose waits would be arbitrary. Same
            # reasoning as the device ordering below.
            window = rows.exclude(pk__in=held_ids) if held_ids else rows
            pending = list(window.order_by("created_at", "id")[:max_rows])
            if not pending:
                if window_number == 0:
                    # **The whole of an idle sweep**: one indexed query and out,
                    # before any of the per-batch lookups below. That early
                    # return is what makes `--loop` cheaper at rest than the
                    # per-minute timer despite running 30× as often, so keep new
                    # per-batch work below this line — and note that the second
                    # window is only ever reached by a drain that already found
                    # a full one, so an idle loop still pays for exactly one
                    # query per pass.
                    self._last_deferred = 0
                    self._last_capped = False
                    self._note_idle("Nothing queued.")
                    return
                break
            examined += len(pending)
            held_before = len(held_ids)

            # One query for every recipient's devices, rather than one per row.
            #
            # **Ordered, and that is not cosmetic.** This list decides the order
            # messages go into the batch, and `_send` matches Expo's reply back
            # onto them *positionally* (`zip(chunk, tickets, strict=True)`) — so
            # which device is credited with which ticket, which one a partial
            # failure leaves outstanding, and which straddle a chunk boundary
            # all follow from it. Unordered, Postgres is free to return whatever
            # physical heap order it currently has, which shifts as rows are
            # inserted and deleted over a table's life; the drain then behaves
            # differently run to run for reasons nothing in the code expresses.
            # It surfaced as a CI-only failure of the partial-multi-device test,
            # which is the mild version — the same non-determinism is what makes
            # a production report of "the wrong device got retried" impossible
            # to reproduce.
            recipient_ids = {row.recipient_id for row in pending}
            devices_by_user = {}
            for device in DevicePushToken.objects.filter(
                user_id__in=recipient_ids
            ).order_by("id"):
                devices_by_user.setdefault(device.user_id, []).append(device)

            read_markers = self._read_markers(pending)
            # Nothing older than the oldest queued message can change any
            # decision below — every comparison is against a row's own
            # `message.created_at` — so this bounds the two history lookups to a
            # range instead of letting them walk the retention window.
            since = self._oldest_message(pending)
            later_messages = self._later_messages(pending, since)
            muted_pairs = self._muted_pairs(pending)
            mention_marks = self._mention_marks(pending, since)
            # Costs a query only when a mention actually arrived mid-burst, and
            # is therefore below `_mention_marks` rather than folded into it:
            # the marks are needed on every drain that has a message row,
            # the messages behind them almost never are.
            mention_messages = self._mention_messages(pending, mention_marks)
            # Gated because it feeds `_should_space_out` and nothing else, so
            # switching the cooldown off (the documented
            # `PUSH_MESSAGE_COOLDOWN_SECONDS=0` path) should not still pay for a
            # grouped query on every drain — which at a 2s cadence is 30 a
            # minute for a feature that is disabled. The other three are not
            # gated: `_should_drop` reads them whatever the cooldown is set to.
            if settings.PUSH_MESSAGE_COOLDOWN_SECONDS > 0:
                last_pushes = self._last_pushes(pending, now)
            else:
                last_pushes = {}

            for row in pending:
                if acted >= max_rows:
                    # A window may be wider than the work (see
                    # _MAX_DRAIN_PAGES), but `--max-rows` still bounds what one
                    # drain *does*. The rest keep their place in the queue and
                    # go out on the next tick, two seconds later.
                    break
                # What this row now stands for: its own message, or the newest
                # thing that coalesced onto it. Computed once because both the
                # drop test and the hold test ask about it, from opposite ends —
                # "have they read all of it" and "is any of it too new to have
                # been read yet" — and answering those off different messages is
                # how a drain both declines to drop a row and declines to hold
                # it. See _newest_covered.
                covered = (
                    self._newest_covered(
                        row, later_messages, mention_marks, muted_pairs
                    )
                    if row.message_id
                    else None
                )
                # Two reasons to drop a message push rather than send it, both
                # settled (not retried) because neither state is ever undone:
                # the message has since been deleted, or the recipient has
                # already read everything the row stands for. See _should_drop.
                if row.message_id and self._should_drop(
                    row, read_markers, covered
                ):
                    settled += 1
                    acted += 1
                    if not dry_run:
                        row.sent_at = timezone.now()
                        row.save(update_fields=["sent_at"])
                    continue
                # Skip devices this row already reached on an earlier attempt,
                # so a retry never re-buzzes a phone that got it the first time.
                delivered = set(row.delivered_tokens or [])
                outstanding = [
                    device
                    for device in devices_by_user.get(row.recipient_id, [])
                    if device.expo_token not in delivered
                ]
                if not outstanding:
                    # Either a web-only user with no devices at all, or every
                    # device was reached earlier. Settle it rather than retrying
                    # forever; the in-app notification exists and is unaffected
                    # either way.
                    settled += 1
                    acted += 1
                    if not dry_run:
                        row.sent_at = timezone.now()
                        row.save(update_fields=["sent_at"])
                    continue
                # Two reasons to hold a message push rather than send it now:
                # the recipient may be about to tell us they've read it
                # (_should_defer), or they were buzzed about this thread moments
                # ago (_should_space_out). Both leave the row **untouched** — no
                # `sent_at`, no `attempts` — because this is "ask again
                # shortly", not a failure: spending an attempt here would let a
                # chatty thread exhaust MAX_ATTEMPTS without Expo ever having
                # been called.
                #
                # **Below the device check on purpose.** There is nothing to
                # protect a recipient with no registered device from — no phone
                # will buzz either way — so deferring one would leave a row
                # queued for a drain that can never send it, and (because
                # `enqueue_message_pushes` coalesces onto any unsent row)
                # suppress the *next* message's row behind it.
                if row.message_id and (
                    self._should_defer(row, read_markers, covered, now)
                    or self._should_space_out(
                        row, last_pushes, mention_marks, now
                    )
                ):
                    deferred += 1
                    held_ids.append(row.pk)
                    continue
                payload = self._payload(row, mention_messages)
                badge = self._badge(row, badges)
                acted += 1
                for device in outstanding:
                    messages.append(
                        (row, device, self._message(device, payload, badge))
                    )

            if (
                acted >= max_rows
                or len(pending) < max_rows
                or len(held_ids) == held_before
            ):
                # Any of three reasons not to look again: this drain has done
                # its share; the queue is shorter than the window, so nothing is
                # hiding behind it; or nothing was held, so the window wasn't
                # squatted in the first place. The last is the ordinary case,
                # which is why a healthy drain still runs exactly one selection.
                break
        else:
            # Every window was full and still holding rows back. Reported rather
            # than shrugged off: work is queued that this drain chose not to
            # look at, and a cap nobody is told about reads exactly like an
            # empty queue — the failure this command's logging is arranged
            # around.
            capped = True

        # Reported on **every** path, not just the empty one. A held row is a
        # fourth outcome beside sent/settled/requeued, and a drain that also has
        # something to send is the usual case — so leaving it off the busy path
        # would make a misconfigured grace look like a perfectly healthy drain
        # while nobody's phone buzzed. See _should_defer.
        #
        # In `--loop` it goes through `_note_idle` and out to the heartbeat
        # instead: a row held for the full cooldown spans thirty drains, and
        # thirty identical lines describe one event, not thirty. The cap is
        # carried the same way and for the same reason.
        self._last_deferred = deferred
        self._last_capped = capped
        if deferred:
            self._note_idle(f"{deferred} message push(es) held back.")
        if capped:
            self._note_idle(
                f"Stopped after {_MAX_DRAIN_PAGES} window(s) of {max_rows}; "
                "more rows are queued behind held ones."
            )

        # Through `_say`, not `_note_idle`: this describes rows whose state
        # changed, so it belongs in the resident log next to "Sent N".
        if settled:
            self._say(
                f"Settled {settled} row(s) without sending "
                "(no device, deleted, or already read)."
            )

        if not messages:
            self._note_idle(
                f"{examined} queued, nothing outstanding to send."
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

    def _oldest_message(self, pending):
        """The earliest ``message.created_at`` in this window, or ``None`` if it
        holds no message rows.

        Every message-row decision below compares something against a row's own
        ``message.created_at``, so nothing earlier than the earliest of them can
        change any answer. Passing it to the history lookups turns them from
        "scan what we have kept" into a bounded range — which matters because
        they now run every two seconds rather than every sixty.
        """
        times = [row.message.created_at for row in pending if row.message_id]
        return min(times) if times else None

    def _later_messages(self, pending, since):
        """``{conversation_id: [(sender_id, newest_created_at), …]}`` for the
        threads in this window, counting only messages after ``since``.

        Read by ``_should_drop`` to answer "is there anything in this thread the
        recipient has *not* read?" — which is the question the drop test needs
        and could not previously ask, because a queued row keeps pointing at the
        message it was created for while later ones coalesce onto it (see the NB
        in ``enqueue_message_pushes``). Comparing the read marker against that
        first message alone means a burst of ten messages is binned in full the
        moment its first is read, and the cooldown made that the *normal* case
        rather than a rarity: it holds the row for a minute, which is a minute
        in which the recipient can glance at the thread and silence nine
        messages they never saw.

        Grouped by sender as well as thread so the caller can ignore the
        recipient's **own** messages. Their read marker is stamped when they
        send (``MessageCreateView``: "sending implies you've read everything up
        to now"), but the two writes are not one instant — so without this a
        recipient who replies in the thread could look like someone with unread
        mail and be buzzed about their own message.

        This does **not** re-check visibility (``ParticipantInterval``) or mute
        the way ``enqueue_message_pushes`` does when it decides who a message is
        news to, and so it can rescue a row on the strength of a message the
        recipient will never see — someone in an interval gap. The cost of that
        is one push saying a thread has moved on, phrased from a message they
        *can* see, which is the mild failure; the cost of the reverse is silent
        loss of real messages. Mute is the case where the difference is not mild
        — a muted thread is a standing request not to be buzzed — so the caller
        takes it out separately, via ``_muted_pairs``.
        """
        conversation_ids = {
            row.message.conversation_id for row in pending if row.message_id
        }
        if not conversation_ids or since is None:
            return {}
        grouped = (
            Message.objects.filter(
                conversation_id__in=conversation_ids,
                deleted_at__isnull=True,
                created_at__gt=since,
            )
            .values("conversation_id", "sender_id")
            .annotate(newest=Max("created_at"))
        )
        latest = {}
        for entry in grouped:
            latest.setdefault(entry["conversation_id"], []).append(
                (entry["sender_id"], entry["newest"])
            )
        return latest

    def _muted_pairs(self, pending):
        """The ``(conversation_id, user_id)`` pairs in this window whose
        recipient has **muted** the thread.

        Only ``_should_drop`` needs it, and only to decide *which* later
        messages count as unread for someone. In an unmuted thread that is any
        message; in a muted one it is only the messages that mention them,
        because those are the only ones ``enqueue_message_pushes`` would have
        queued or coalesced for them in the first place. Without this, chatter
        in a muted thread would resurrect a mention's push after the mention had
        been read — buzzing someone through a quiet they asked for, which is the
        one thing mute has to be able to promise.
        """
        conversation_ids = {
            row.message.conversation_id for row in pending if row.message_id
        }
        if not conversation_ids:
            return set()
        return set(
            Participant.objects.filter(
                conversation_id__in=conversation_ids,
                user_id__in={row.recipient_id for row in pending},
                muted_at__isnull=False,
            ).values_list("conversation_id", "user_id")
        )

    def _last_pushes(self, pending, now):
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

        **Bounded to the cooldown window.** The only thing the caller can do
        with the answer is compare it against ``now - cooldown``, so anything
        older is indistinguishable from nothing at all — and without the bound
        this walks the whole retention window (a fortnight of sent rows, joined
        to ``api_message``) every two seconds, which would make the resident
        drain more expensive on a busy queue than the per-minute timer it
        replaced rather than less.
        """
        pairs = self._message_pairs(
            pending, "message__conversation_id", "recipient_id"
        )
        if pairs is None:
            return {}
        cooldown = timedelta(seconds=settings.PUSH_MESSAGE_COOLDOWN_SECONDS)
        grouped = (
            PushOutbox.objects.filter(
                pairs, sent_at__gte=now - cooldown
            )
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

    def _readable_mentions(self):
        """``MessageMention`` rows whose target could actually read the message
        that named them — the base every mention lookup below starts from.

        Two lookups need this exact set (``_mention_marks``, which decides
        whether a mention beats the cooldown or rescues a muted thread, and
        ``_mention_messages``, which decides what the push then *says*), and a
        mention one of them counted while the other didn't would mean a push
        channelled as a mention but phrased as chatter, or the reverse. One
        queryset, so there is nothing to keep in step.

        **Soft-deleted messages are excluded.** A mention taken back should not
        go on punching a push through the cooldown, and ``_should_drop`` already
        treats a deleted message as a reason not to send at all.

        **The interval test and nothing else** (issue #366), matching
        ``views.visible_messages_for``, which is what "can this person read this
        message" means. ``enqueue_message_pushes``'s other three clauses
        (``status``, ``left_at``, ``user__is_active``) are *not* repeated here,
        and adding them would be a subtle bug rather than belt-and-braces: over
        there they are read at the instant the message is created, so they
        describe that moment; here they would be read whenever the drain happens
        to run, and a member who drops to ``pending`` between the mention and the
        drain keeps their pre-gap history — the mention is still readable, and
        their closed interval still spans it. Membership *now* is a different
        question from readability *then*.

        The ``Exists`` costs a correlated subquery on lookups that run every two
        seconds; callers bound it by ``since`` and by the batch's pairs, both its
        joins are on indexed foreign keys, and the flat alternative would mean
        re-testing the interval span in Python — i.e. a third copy of the rule
        ``interval_spans`` exists to stop duplicating.
        """
        # Correlated per *mention*, not per batch: the interval test is against
        # the moment of that mention's own message, so it can't be hoisted into
        # the outer query.
        readable = Participant.objects.filter(
            conversation_id=OuterRef("message__conversation_id"),
            user_id=OuterRef("user_id"),
        ).filter(interval_spans(OuterRef("message__created_at")))
        return MessageMention.objects.filter(
            Exists(readable), message__deleted_at__isnull=True
        )

    def _mention_marks(self, pending, since):
        """``{(conversation_id, user_id): newest_mention_time}`` for the message
        rows in this batch, counting only mentions after ``since``.

        Read by ``_should_space_out`` to answer "has this person been named in
        this thread since the message their queued push points at?" — which is
        the question the cooldown's @mention exemption actually needs, because a
        row covers every message that coalesced onto it, not just its own. Read
        by ``_should_drop`` for the same fact in a muted thread, where a mention
        is the *only* kind of message that coalesces onto a queued row.

        Bounded by ``since`` — the oldest queued message in the window — for the
        reason ``_last_pushes`` is: every caller compares the answer against a
        row's own ``message.created_at``, so an older mention cannot change any
        decision, and leaving the range open makes a query that runs every two
        seconds walk the whole mention history of every thread in the batch.

        The **newest** mention is all that need be stored: the caller compares it
        against the row's own message time, and if the most recent mention is
        older than that, no later one exists to find. ``_mention_messages`` turns
        that timestamp back into the message when the wording needs it.

        Which mentions count at all is ``_readable_mentions``'s question, not
        this one's.
        """
        pairs = self._message_pairs(
            pending, "message__conversation_id", "user_id"
        )
        if pairs is None or since is None:
            return {}
        grouped = (
            self._readable_mentions()
            .filter(pairs, message__created_at__gte=since)
            .values("message__conversation_id", "user_id")
            .annotate(newest=Max("message__created_at"))
        )
        return {
            (entry["message__conversation_id"], entry["user_id"]): entry["newest"]
            for entry in grouped
        }

    def _mention_messages(self, pending, mention_marks):
        """``{(conversation_id, user_id): Message}`` — the mention a queued row
        should *speak for*, where that isn't the message it points at (issue
        #346).

        **The bug this closes.** ``enqueue_message_pushes`` coalesces a burst
        onto one row, and the row goes on pointing at the burst's *first*
        message. ``_payload`` reads the sender, the photo and — the one that
        matters — ``is_mentioned`` off that message, so Ada saying "chatter" and
        then "@Bea can you make it" inside one drain window gets Bea a push
        phrased "New message from Ada" on the **messages** channel. Which is the
        precise outcome the mentions channel exists to prevent: turn Messages
        down to quieten a busy group chat and you have silenced your @mentions
        with it. ``Kind.MENTION`` never creates a ``Notification``, so a mention
        has no other route it could have taken.

        **Why this and not ``.update(message=…)`` on the row.** Re-pointing the
        row looks like three lines and is a trap. It can violate
        ``unique_message_push_per_recipient`` when two concurrent sends have each
        queued a row, and ``enqueue_message_pushes`` runs inside the
        message-create transaction — so that is a 500 for the *sender*. It
        strands ``delivered_tokens``, ``attempts`` and ``last_error`` describing
        a different message. It lets a later soft-delete bin a push that covered
        earlier undeleted messages. And an UPDATE takes row locks that this
        command holds across its Expo HTTP calls, so a slow Expo would start
        blocking message sends — breaking the promise the call site makes, that
        the send is out-of-band and Expo being down can never slow down sending a
        message. Nothing here is written: the answer is assembled for the payload
        and thrown away.

        **Only where it changes something.** A pair is looked up only when the
        newest readable mention is *strictly newer* than the row's own message,
        which is what keeps this symmetric. The reverse case — a mention followed
        by chatter — has the mention as the row's own message, and re-pointing at
        the newest message would take the mentions channel *away* from a push
        that correctly had it. So the common burst, and every batch with no
        mid-burst mention in it at all, pays nothing: no wanted pairs, no query.

        Keyed on the exact ``created_at`` ``_mention_marks`` chose rather than
        re-deriving "the newest one", so the two lookups cannot pick different
        messages — the row would then be channelled off one mention and phrased
        off another.
        """
        pairs = Q(pk__in=[])
        wanted = 0
        for row in pending:
            if not row.message_id:
                continue
            key = (row.message.conversation_id, row.recipient_id)
            when = mention_marks.get(key)
            if when is None or when <= row.message.created_at:
                continue
            wanted += 1
            pairs |= Q(
                message__conversation_id=key[0],
                user_id=key[1],
                message__created_at=when,
            )
        if not wanted:
            return {}
        found = {}
        # ``select_related``/``prefetch_related`` mirror what ``_drain`` joins
        # onto ``row.message``: ``message_push_body`` reads the sender's name and
        # the conversation's kind and title, and ``is_mentioned`` iterates the
        # prefetched mentions rather than querying. Without these the fix would
        # cost four queries per re-pointed row.
        #
        # Ordered so that two mentions sharing a microsecond — the only way a
        # pair can match twice — resolve the same way on every run rather than
        # on whatever heap order Postgres happens to return.
        for mention in (
            self._readable_mentions()
            .filter(pairs)
            .select_related(
                "message", "message__sender", "message__conversation"
            )
            .prefetch_related("message__mentions")
            .order_by("message_id")
        ):
            found[(mention.message.conversation_id, mention.user_id)] = (
                mention.message
            )
        return found

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

    def _should_drop(
        self, row, read_markers, covered
    ):
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

        **Read *what*, though.** A queued row keeps pointing at the message it
        was created for while every later message in the thread coalesces onto
        it, so "have they read ``row.message``?" is the wrong question the
        moment a burst is involved: answering yes bins the nine messages behind
        it as well, and nothing anywhere records that it happened. The cooldown
        (issue #354) turned that from a race into the normal case, because it
        deliberately holds the row for a minute — a minute in which a glance at
        the thread on a laptop silences the phone for everything that arrives
        next. So the marker is compared against ``covered``
        (``_newest_covered``) — the newest message the row now stands for — and
        only a recipient who is genuinely caught up is dropped.

        What the row *says* when it does go out is phrased from its first
        message still, except where a mid-burst @mention overrides it
        (``_mention_messages``, issue #346) — a push naming the wrong sender of a
        real unread message is a smaller wrong than no push at all, which is what
        this fixes, and a mention is the one case where the wrong name costs a
        channel too.

        The deleted branch is deliberately left as "drop, full stop". It has the
        same shape of hole — a burst whose *first* message is deleted takes the
        rest of the burst's push with it — but a row that points at deleted
        content is the one case where "a push for deleted content cannot fire"
        is the stronger promise, and it is the promise the reference docs make.
        """
        if row.message.deleted_at is not None:
            return True
        marker = read_markers.get(
            (row.message.conversation_id, row.recipient_id)
        )
        if marker is None:
            return False
        return marker >= covered

    def _newest_covered(self, row, later_messages, mention_marks, muted_pairs):
        """The newest message this queued row now stands for.

        A row keeps pointing at the message it was created for while every later
        message in the thread coalesces onto it, so ``row.message`` is the
        *oldest* thing it announces, not the newest. Two rules need the newest —
        ``_should_drop`` ("have they read all of it?") and ``_should_defer``
        ("is any of it too new to have been read yet?") — and they are the same
        question asked from opposite ends. Answering them off different messages
        is how a drain both declines to drop a row *and* declines to hold it,
        which is the shape of the bug this closes (issue #346, and #355 with it).

        Computed once per row in ``_drain`` and passed to both, so the two
        cannot drift.

        **A muted thread counts only mentions**, because those are the only
        messages ``enqueue_message_pushes`` would have queued or coalesced for
        this recipient (see ``_muted_pairs``); ordinary chatter in a thread they
        silenced must not resurrect a push they have already read, nor hold one
        back on the strength of an arrival they never asked to hear about.

        **The recipient's own messages don't count** in the unmuted branch.
        Sending stamps the read marker (``MessageCreateView``: "sending implies
        you've read everything up to now"), but the two writes are not one
        instant — so counting your own reply would make you look like someone
        with unread mail.

        Never earlier than the row's own message: a burst only ever grows what a
        row stands for.
        """
        key = (row.message.conversation_id, row.recipient_id)
        if key in muted_pairs:
            newest = mention_marks.get(key)
        else:
            newest = max(
                (
                    when
                    for sender_id, when in later_messages.get(key[0], ())
                    if sender_id != row.recipient_id
                ),
                default=None,
            )
        covered = row.message.created_at
        if newest is not None and newest > covered:
            covered = newest
        return covered

    def _should_defer(self, row, read_markers, covered, now):
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

        **Which message's age** (issue #346). ``covered``, not
        ``row.message.created_at`` — the newest message the row stands for, from
        ``_newest_covered``, the same quantity ``_should_drop`` compares the
        marker against. A coalesced row's own message is the *oldest* thing it
        announces, and asking that one produced a specific, repeatable buzz for
        someone staring at the thread: a row held the full cooldown is a minute
        old at release, so the age test said "far too old to defer" while the
        message it was about to announce was half a second old and had not
        reached the recipient's client yet. That is the exact #355 failure this
        method exists to prevent, re-opened by the coalescing — and the busy
        thread where it happens is precisely the one that is being read.

        Asking the same message as ``_should_drop`` is what makes the two
        coherent: a row is either caught up (drop), too fresh to judge (hold), or
        neither (send). Off two different messages it could be none of them.

        **What it costs — much less than it used to.** A deferred row waits for
        the next drain, which is now two seconds away rather than up to sixty, so
        one hold costs the grace: six seconds. That is also why
        ``PUSH_ACTIVE_THREAD_SECONDS`` could be widened from 15s to 120s — a wide
        window used to mean minute-long holds and now means six-second ones,
        while a narrow one misses the silent reader whose marker hasn't moved
        because nothing has arrived to move it.

        **It cannot strand a row**, though the argument is now two-sided rather
        than one. A hold needs *both* halves to be true at once: something in the
        thread newer than ``now - grace``, **and** a read marker newer than
        ``now - PUSH_ACTIVE_THREAD_SECONDS``. Neither the message times nor the
        marker move on their own, so a thread that goes quiet for six seconds
        releases the row, and a recipient who stops touching the thread releases
        it within the active window whatever the thread is doing. The one case
        that holds for longer is a thread taking a message every few seconds from
        someone who is demonstrably in it — where every drain in between re-asks
        ``_should_drop``, which is the outcome actually wanted for a reader. It
        used to be capped at the grace outright, because the age test asked a
        timestamp that could not move; that cap was bought with the bug above.

        **Known limitation: "active" is broader than "reading".** The marker is
        also stamped when the recipient *sends* (``MessageCreateView`` —
        "sending implies you've read everything up to now") and when they swipe
        **Mark read** on the conversation list. So someone who fires off a reply
        and pockets the phone looks active for the next
        ``PUSH_ACTIVE_THREAD_SECONDS``, and a reply arriving in that window is
        held for a grace. This used to be the argument for keeping the window
        small; with a resident drain each hold is six seconds, which is why the
        window could stop paying for it. The alternative — telling the three
        apart — needs a presence signal this deliberately avoids.

        This deliberately does **not** try to answer "is the thread on screen".
        That needs a presence signal from the client, and the whole point of
        leaning on ``ConversationRead`` is that it is state the app already
        maintains for its own reasons.
        """
        grace = timedelta(seconds=settings.PUSH_MESSAGE_GRACE_SECONDS)
        if now - covered >= grace:
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

    def _payload(self, row, mention_messages):
        """The ``(text, url, kind, id)`` a push is built from, for either target.

        A notification defers entirely to ``NotificationSerializer`` so the phone
        and the activity centre read identically. A message has no in-app row to
        match, so it's phrased here.

        ``mention_messages`` (from ``_mention_messages``) is how a coalesced row
        stops answering for its first message alone; a batch with no mid-burst
        mention in it hands over an empty dict and nothing below changes.
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

        # **Not simply ``row.message``** (issue #346). A queued row keeps
        # pointing at the message it was created for while every later message
        # in the thread coalesces onto it, so a mention arriving mid-burst would
        # otherwise be phrased and channelled as whatever the burst *opened*
        # with. ``_mention_messages`` supplies the mention itself for exactly the
        # pairs where that has happened, and nothing else — a burst with no
        # mention in it still speaks for its first message, which is the
        # trade-off ``_should_drop`` documents: a push naming the wrong sender of
        # a real unread message is a smaller wrong than no push at all, and the
        # preview endpoint replaces the body device-side anyway.
        message = mention_messages.get(
            (row.message.conversation_id, row.recipient_id), row.message
        )
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

        sent = requeued = gave_up = reaped = 0
        # How long the rows this batch actually *delivered* waited between being
        # enqueued and being accepted by Expo — **our** half of push latency,
        # which is the only half we can do anything about (issue #354). Reported
        # because the alternative is guessing: Expo → APNs/FCM → device adds
        # 1-5s nobody here can see, so "is the delay ours?" is unanswerable
        # without this number, and it is the number that says whether tuning the
        # drain interval further would achieve anything at all. The worst wait
        # rather than the mean: a batch's slowest row is the one a person
        # notices. **Delivered only** (issue #365): a row that settled having
        # rung nobody has no latency worth reporting.
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
                if row.attempts >= PushOutbox.MAX_ATTEMPTS:
                    # **Out of retries, so settle it here rather than leaving it
                    # to be recognised as dead by everyone who reads the table.**
                    # `_drain` will never select this row again, so an unstamped
                    # `sent_at` means "queued" for ever — which is how #347
                    # happened, and it is not only the enqueue that would have
                    # to know: `_last_pushes` bounds its scan on `sent_at`, so
                    # without a stamp a row that reached a phone on attempt one
                    # and then died retrying a second device is invisible to the
                    # cooldown, and the very next message re-buzzes that phone
                    # immediately. Stamping it gives every reader one meaning of
                    # "still going to be sent" instead of a rule each has to
                    # restate. It is *not* claiming a delivery: whether anyone
                    # was reached is `delivered_tokens`, which is exactly what
                    # `_last_pushes` reads and what `__str__` renders.
                    row.sent_at = timezone.now()
                    gave_up += 1
                else:
                    requeued += 1
            else:
                row.sent_at = timezone.now()
                # **Cumulative, not this tick's.** A row can deliver to one
                # device on an early attempt and settle later when its last
                # outstanding device turns out to be dead, so asking
                # `entry["delivered"]` — which only covers this pass — would
                # report a phone that really did buzz as having reached nobody.
                # `delivered_tokens` is the row's whole history and is what
                # `_last_pushes` reads (issue #365), so the two agree.
                if row.delivered_tokens:
                    waits.append((row.sent_at - row.created_at).total_seconds())
                    sent += 1
                else:
                    # Settled having reached nobody: every device this row still
                    # had outstanding came back `DeviceNotRegistered` and was
                    # reaped above, so there was no error to requeue on and no
                    # delivery either. Counted apart from `sent` because `sent`
                    # is the operator's answer to "is the delay ours?", and a
                    # latency figure for a push that rang no phone is worse than
                    # no figure. Worth seeing in its own right: a reap means a
                    # reinstall or a token rotation.
                    reaped += 1
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
        if gave_up:
            summary += f", gave up on {gave_up} after {PushOutbox.MAX_ATTEMPTS}"
        if reaped:
            summary += f", {reaped} reached nobody (dead token reaped)"
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
            # blocking the queue's index forever. `_send` now stamps `sent_at`
            # the moment a row gives up, so new ones are already caught by the
            # clause above at the same cutoff — this stays for rows that died
            # before that, which have no stamp and would otherwise never be
            # collected.
            | Q(attempts__gte=PushOutbox.MAX_ATTEMPTS, created_at__lt=cutoff)
        )
        if dry_run:
            self._say(f"Would prune {stale.count()} row(s).")
            return
        deleted, _ = stale.delete()
        if deleted:
            self._say(f"Pruned {deleted} row(s).")
