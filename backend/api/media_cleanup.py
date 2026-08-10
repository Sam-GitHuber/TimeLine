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

So the sweep hangs off the model instead: a ``post_delete`` receiver per
file-bearing model, connected in ``ApiConfig.ready``. Three things fall out of
that, and they're the reason this beats hand-gathering:

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

There is deliberately **no** receiver-based answer for *replacing* a file (a new
avatar over an old one): no row is deleted there, so ``imaging.save_avatar`` and
``imaging.clear_avatar`` call ``delete_files_on_commit`` directly. That's the one
remaining hand-call, and it's on the same mechanism.
"""

import logging

from django.db import transaction
from django.db.models.signals import post_delete

logger = logging.getLogger(__name__)


# Every file-bearing model in the project and the file fields on it. There are no
# others — if you add a ``FileField``/``ImageField`` to a model, add it here or
# its uploads will outlive the rows that own them.
#
# ``accounts.User`` is registered from the ``api`` app rather than ``accounts``
# on purpose: ``api`` already depends on ``accounts`` (every FK points that way),
# and having ``accounts`` reach into ``api`` for the sweep would invert that for
# no gain. The receiver only needs the model, not the app it lives in.
MEDIA_FILE_FIELDS = {
    ("accounts", "User"): ("avatar", "avatar_thumb"),
    ("api", "Group"): ("avatar", "avatar_thumb"),
    ("api", "PostImage"): ("image", "thumbnail"),
    ("api", "EventPhoto"): ("image", "thumbnail"),
    ("api", "MessageAttachment"): ("file", "thumbnail"),
}


def delete_files_on_commit(files):
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

    transaction.on_commit(_remove)


def sweep_media_after_delete(sender, instance, **kwargs):
    """``post_delete`` receiver: queue this row's files for removal."""
    field_names = MEDIA_FILE_FIELDS[(sender._meta.app_label, sender._meta.object_name)]
    delete_files_on_commit(getattr(instance, name) for name in field_names)


def register_media_cleanup(app_registry):
    """Connect :func:`sweep_media_after_delete` to every file-bearing model.

    Called from ``ApiConfig.ready``. ``dispatch_uid`` keeps a re-imported module
    (the autoreloader, or a test that reloads apps) from connecting twice and
    sweeping the same file twice.
    """
    for (app_label, model_name), _fields in MEDIA_FILE_FIELDS.items():
        post_delete.connect(
            sweep_media_after_delete,
            sender=app_registry.get_model(app_label, model_name),
            dispatch_uid=f"media-cleanup:{app_label}.{model_name}",
        )
