"""Taking a file off storage when the row that pointed at it goes.

Deleting a row does **not** delete the file it points at — Django leaves that to
the application on purpose, because file deletion isn't transactional. That isn't
merely untidy here: an orphaned JPEG stays *fetchable* by anyone holding its URL,
because ``media_auth`` gates on being signed in rather than on owning the file
(see ``docs/reference/feed-and-posts.md``). A "deleted" photo that still serves
at its old URL isn't deleted, and the maintainer's takedown lever is a delete.

This used to be a **call-site convention**: every view that destroyed content
gathered the files by hand and passed them to ``delete_files_on_commit``, with a
line in ``docs/reference/accounts.md`` asking future delete paths to remember.
Every path that didn't — the Django admin, which *is* the documented moderation
route, and the management commands — silently left files behind (issue #222). A
convention that has to be re-followed at each new call site is not a rule.

So the sweep hangs off the model instead: a ``post_delete`` receiver on every
model that has a file field, connected in ``ApiConfig.ready``. Three things fall
out of that, and they're the reason this beats hand-gathering:

* **Cascades are covered.** Deleting a group destroys its posts', events' and
  chats' photos through several layers of FK; deleting a user reaches other
  people's files through ``Event.organiser`` and ``Conversation.user_a``. Each
  of those needed its own hand-written query before, and getting the set wrong
  was silent. The collector walks the cascade for us.
* **Bulk deletes are covered.** Registering a ``post_delete`` listener disables
  Django's fast-delete optimisation (``db/models/deletion.py``,
  ``Collector.can_fast_delete``) — which is precisely *why* the signal then
  fires for cascaded and ``queryset.delete()``-ed rows too. The cost is an extra
  query and the instances in memory per cascade; irrelevant at this scale, and
  the point of the trade.
* **The ordering is right by construction.** ``Collector.delete`` runs inside
  its own ``transaction.atomic``, so an ``on_commit`` callback registered from a
  receiver waits for that delete to commit — and is discarded if it rolls back.
  Callers don't have to open a transaction to make the sweep safe.

**The set of models is derived, not listed.** Anything else would just move the
convention from the call sites to a registry someone has to remember to update —
the same failure with a different address. ``media_file_fields`` reads every
concrete model in our own apps and picks out its ``FileField``s (``ImageField``
is one), so a new file field is covered the moment it exists.
``api.tests.MediaFileFieldRegistryTests`` pins the derived set, so *losing*
coverage is a test failure rather than a silent regression.

There is deliberately **no** receiver-based answer for *replacing* a file (a new
avatar over an old one): no row is deleted there, so ``imaging.save_avatar`` and
``imaging.clear_avatar`` call ``delete_files_on_commit`` directly. That's the one
remaining hand-call, and it's on the same mechanism. Because that path exists,
**a file field must never be editable in the Django admin** — the admin's own
"Clear" checkbox blanks the column without deleting a row, so no receiver fires
and the file is orphaned; and an upload through the admin skips
``imaging.process_image`` entirely, storing a client's file with its EXIF (and
GPS) intact. Both admins render these fields read-only for those two reasons.
"""

import logging

from django.db import models, transaction
from django.db.models.signals import post_delete

logger = logging.getLogger(__name__)


# Only our own apps. A third-party model's files aren't ours to decide the
# lifecycle of, and none of the ones we install have file fields anyway.
MEDIA_APP_LABELS = ("accounts", "api")

# Receivers are kept alive here because ``post_delete.connect`` holds its
# listeners weakly by default, and these are closures with no other reference.
_receivers = []


def media_file_fields(app_registry):
    """``{model: (file field name, …)}`` for every file-bearing model we own.

    Derived rather than hand-listed, so adding an ``ImageField`` to a model can't
    quietly opt that model out of the sweep. Proxies are skipped: they'd connect
    a second receiver against the same table and sweep every file twice.
    """
    found = {}
    for model in app_registry.get_models():
        if model._meta.app_label not in MEDIA_APP_LABELS or model._meta.proxy:
            continue
        names = tuple(
            field.name
            for field in model._meta.fields
            if isinstance(field, models.FileField)
        )
        if names:
            found[model] = names
    return found


def delete_files_on_commit(files, using=None):
    """Remove ``files`` from storage once the current transaction commits.

    On-commit rather than inline because file deletion isn't transactional: if
    the surrounding delete rolls back, an inline sweep would already have
    destroyed files whose rows are still live and still referencing them. The
    ordering can only err on the safe side — a crash between commit and sweep
    leaves an orphaned file (recoverable, invisible in the app), never a live
    row pointing at nothing.

    ``files`` are ``FieldFile``s, but what's kept is a ``(storage, name)``
    snapshot taken **now**. That matters for the replacement path: a
    ``FieldFile`` is a live view onto its field, so ``instance.avatar.save(...)``
    mutates the very object we were handed, and holding the object would sweep
    the *new* avatar instead of the old one. Snapshotting also means the callback
    can't be affected by anything the caller does to the instance afterwards.

    ``using`` is the database alias the delete ran on, so the callback attaches
    to *that* connection's commit rather than the default one. Single-database
    today; getting it wrong on a second one would mean registering against a
    connection in autocommit, where ``on_commit`` fires immediately — i.e. the
    inline delete this exists to avoid.

    Each file is swept independently. These callbacks run *after* the commit, so
    letting one storage error abort the loop would both strand every remaining
    file and raise out of a delete that has already succeeded — turning a
    best-effort cleanup into a 500 for content that is genuinely gone.
    """
    # Empty fields (no avatar set) have no name and nothing to remove.
    targets = [(f.storage, f.name) for f in files if f]
    if not targets:
        return

    def _remove():
        for storage, name in targets:
            try:
                storage.delete(name)
            except Exception:
                # Already-missing files are a no-op in Django, so reaching here
                # means storage itself refused (permissions, read-only mount, a
                # remote-storage blip). Log it for manual cleanup and continue.
                logger.exception("Could not delete stored file %r", name)

    transaction.on_commit(_remove, using=using)


def _sweeper(field_names):
    """Build the ``post_delete`` receiver for a model with these file fields.

    The names are bound at connect time rather than looked up per row, so a
    dispatch can't fail on a missing registry entry inside the delete's own
    transaction.
    """

    def sweep_media_after_delete(sender, instance, using=None, **kwargs):
        # ``getattr`` here assumes the file fields were loaded. A caller that
        # ``defer()``s or ``only()``s them and then deletes would send Django to
        # refresh a row that no longer exists — a loud failure that rolls the
        # delete back, which is the safe direction, but don't defer them.
        delete_files_on_commit(
            (getattr(instance, name) for name in field_names), using=using
        )

    return sweep_media_after_delete


def register_media_cleanup(app_registry):
    """Connect a file sweep to every file-bearing model. Called from ``ready``.

    ``dispatch_uid`` keeps a re-imported module (the autoreloader, or a test that
    reloads apps) from connecting twice and sweeping the same file twice.
    """
    for model, field_names in media_file_fields(app_registry).items():
        receiver = _sweeper(field_names)
        _receivers.append(receiver)
        post_delete.connect(
            receiver,
            sender=model,
            weak=False,
            dispatch_uid=f"media-cleanup:{model._meta.label}",
        )
