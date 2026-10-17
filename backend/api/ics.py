"""One event as an iCalendar (``.ics``) file — "Add to my calendar" (issue #418).

Written by hand rather than with a library: a single ``VEVENT`` is a page of
RFC 5545, and the only parts with teeth — text escaping and line folding — are
a few lines each. A dependency would be more code to trust than this.

Two choices worth knowing about:

- **Timed events are written in UTC** (``DTSTART:20261018T170000Z``), not as
  ``TZID=Europe/London``. RFC 5545 requires every ``TZID`` to be defined by a
  ``VTIMEZONE`` block in the same file, and generating those (DST transition
  rules) by hand is exactly the fiddly part a library exists for. A UTC instant
  needs no definition, every calendar app reads it, and each app shows it in
  its owner's own zone anyway. The event's zone still decides *which* instant —
  "19:00 in Europe/London" — before it is converted.
- **The file names nobody.** No ``ORGANIZER`` or ``ATTENDEE`` lines: the file
  leaves the app on purpose, into whatever calendar service the user picks, and
  the names in an event are gated per viewer (events.md decision 2). Title,
  description, location and a link back is all it carries.
"""

import re
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from django.conf import settings as dj_settings
from django.utils import timezone

from .models import Event

PRODID = "-//TimeLine//Events//EN"

# TEXT values may hold HTAB but no other control characters (RFC 5545 §3.3.11).
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def escape_text(value):
    """Escape a TEXT value: backslash first, then the separators, then newlines
    (``\\r\\n`` / ``\\r`` normalised to one ``\\n``)."""
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    value = (
        value.replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\n", "\\n")
    )
    return _CONTROL_CHARS.sub("", value)


def fold_line(line):
    """Fold a content line to at most 75 **octets** per physical line (RFC 5545
    §3.1), continuation lines starting with a single space. Splits only between
    characters, never inside a multi-byte UTF-8 sequence — so a long title in
    any script still decodes."""
    out = []
    current = ""
    current_len = 0
    limit = 75
    for ch in line:
        n = len(ch.encode("utf-8"))
        if current_len + n > limit:
            out.append(current)
            # The leading space of a continuation line counts toward its 75.
            current, current_len, limit = " ", 1, 75
        current += ch
        current_len += n
    out.append(current)
    return "\r\n".join(out)


def _utc_stamp(dt):
    return dt.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")


def _event_tz(event):
    """The event's zone, falling back to the site zone exactly as
    ``Event.starts_at`` does — the file and the app must agree on the instant."""
    try:
        return ZoneInfo(event.timezone or dj_settings.TIME_ZONE)
    except Exception:
        return ZoneInfo(dj_settings.TIME_ZONE)


def _when_lines(event):
    """``DTSTART`` / ``DTEND`` for a dated event.

    - **All-day** (no start time): ``VALUE=DATE``, with ``DTEND`` the *next*
      day — the end of an all-day event is exclusive in iCalendar, so a
      same-day ``DTEND`` would be a zero-length event.
    - **Timed**: UTC instants (see the module docstring). An end time at or
      before the start is read as running past midnight (a 22:00–02:00 party);
      an end equal to the start, or none at all, leaves ``DTEND`` out, which
      RFC 5545 defines as ending when it starts — honest about what we know
      rather than inventing a duration.
    """
    if event.start_time is None:
        start = event.event_date
        end = start + timedelta(days=1)
        return [
            f"DTSTART;VALUE=DATE:{start.strftime('%Y%m%d')}",
            f"DTEND;VALUE=DATE:{end.strftime('%Y%m%d')}",
        ]
    tz = _event_tz(event)
    start = datetime.combine(event.event_date, event.start_time, tzinfo=tz)
    lines = [f"DTSTART:{_utc_stamp(start)}"]
    if event.end_time is not None and event.end_time != event.start_time:
        end_date = event.event_date
        if event.end_time < event.start_time:
            end_date += timedelta(days=1)
        end = datetime.combine(end_date, event.end_time, tzinfo=tz)
        lines.append(f"DTEND:{_utc_stamp(end)}")
    return lines


def _description(event, event_link):
    """The description, plus what has no property of its own: the organiser's
    location note and link, and the way back to the event."""
    parts = []
    if event.description.strip():
        parts.append(event.description.strip())
    if event.location_note.strip():
        parts.append(event.location_note.strip())
    if event.location_url:
        parts.append(f"Location: {event.location_url}")
    parts.append(f"On TimeLine: {event_link}")
    return "\n\n".join(parts)


def event_ics(event, event_link, uid_host):
    """The ``.ics`` text for one **dated** event (``event_date`` set), CRLF line
    endings throughout.

    ``event_link`` is the absolute URL of the event's page; ``uid_host`` the
    domain in its ``UID``. The UID is ``event-<id>@<host>`` — stable for the
    event's whole life — so downloading again after a change (or a cancel)
    updates the entry already in someone's calendar instead of adding a second
    copy, in the apps that honour it.

    A cancelled event is still exported, as ``STATUS:CANCELLED``: re-importing
    it is how someone who already added it gets it marked off.
    """
    status = (
        "CANCELLED" if event.status == Event.Status.CANCELLED else "CONFIRMED"
    )
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        f"PRODID:{PRODID}",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "BEGIN:VEVENT",
        f"UID:event-{event.id}@{uid_host}",
        f"DTSTAMP:{_utc_stamp(timezone.now())}",
        f"LAST-MODIFIED:{_utc_stamp(event.updated_at)}",
        *_when_lines(event),
        f"SUMMARY:{escape_text(event.title)}",
        f"DESCRIPTION:{escape_text(_description(event, event_link))}",
    ]
    if event.location_name.strip():
        lines.append(f"LOCATION:{escape_text(event.location_name.strip())}")
    lines += [
        f"URL:{event_link}",
        f"STATUS:{status}",
        "END:VEVENT",
        "END:VCALENDAR",
    ]
    return "".join(fold_line(line) + "\r\n" for line in lines)


def ics_filename(event):
    """A safe download name from the title — ASCII letters, digits and dashes
    only, so it needs no quoting in ``Content-Disposition``."""
    slug = re.sub(r"[^a-z0-9]+", "-", event.title.lower()).strip("-")[:60]
    return f"{slug.strip('-') or 'event'}.ics"
