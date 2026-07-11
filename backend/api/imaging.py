"""Image validation + processing for post photos and avatars (Phase 4).

Everything that touches an uploaded image funnels through here so the safety
rules live in one place:

- **Validate by decoding, never by trusting the extension or Content-Type.**
  A file is only accepted if Pillow can actually open it *and* its detected
  format is one of a small raster allow-list. SVG is deliberately excluded — it
  can carry script and become stored XSS when served.
- **Strip all metadata (EXIF, incl. GPS).** Phone photos routinely embed the
  location they were taken — a real privacy leak for family photos. We first
  apply the EXIF orientation (so the photo isn't stored sideways), then rebuild
  the image from raw pixels, which carries no metadata into the saved file.
- **Bound size + dimensions.** Reject oversized uploads and downscale the stored
  original, so one post can't balloon storage/bandwidth.

Processing is synchronous (fine at family scale). If image volume ever grows,
move it to a background worker (Celery/RQ) — see docs/SHARED.md's "add later".
"""

from io import BytesIO
from pathlib import Path
from uuid import uuid4

from django.core.files.base import ContentFile
from PIL import Image, ImageOps, UnidentifiedImageError
from rest_framework import serializers

# Hard cap on a single uploaded file. This is a DoS/memory guard only — it stops
# a client streaming an unbounded file into Pillow — NOT a storage limit. Every
# accepted photo is downscaled (POST_IMAGE_MAX_EDGE) and re-encoded at JPEG q85
# below, so the *stored* file is typically well under 1 MB regardless of how big
# the upload was. Set it to a realistic phone-photo ceiling: modern iPhone/Android
# cameras routinely produce single 12–25 MB photos, so a lower cap would wrongly
# reject ordinary camera-roll uploads (the whole "up to 10 photos" flow) even
# though compression would have handled the size moments later. See issue #40.
MAX_UPLOAD_BYTES = 30 * 1024 * 1024  # 30 MB

# Raster formats we accept. SVG is intentionally absent (script vector → XSS);
# so is anything Pillow can't identify. MPO is included because phones/cameras
# routinely save "JPEGs" as Multi-Picture Objects (a primary image plus an
# embedded second frame) — Pillow reports their format as "MPO", not "JPEG". It's
# JPEG-based and safe: _strip_and_encode flattens it to a plain JPEG (primary
# frame only). Without it, a normal phone photo gets wrongly rejected.
ALLOWED_FORMATS = {"JPEG", "PNG", "WEBP", "GIF", "MPO"}

# Cap photos per post — bounds the work one request can trigger and the size of
# a feed payload.
MAX_IMAGES_PER_POST = 10

# Longest-edge caps. Originals are downscaled to keep storage sane; thumbnails
# are what the feed/profile render so pages stay light.
POST_IMAGE_MAX_EDGE = 2048
POST_THUMB_EDGE = 512
AVATAR_MAX_EDGE = 512
AVATAR_THUMB_EDGE = 128


# --- upload_to callables -----------------------------------------------------
# Must be module-level named functions (not closures) so Django migrations can
# serialise the reference. Each returns a UUID filename under a subdir, so a raw
# media URL can't be guessed by walking ids (defence in depth — dev serves media
# openly; real access control is Phase 7).


def _uuid_name(subdir, filename):
    ext = (Path(filename).suffix or ".jpg").lower()
    return f"{subdir}/{uuid4().hex}{ext}"


def post_image_upload_to(instance, filename):
    return _uuid_name("posts", filename)


def post_thumb_upload_to(instance, filename):
    return _uuid_name("posts/thumbs", filename)


def avatar_upload_to(instance, filename):
    return _uuid_name("avatars", filename)


def avatar_thumb_upload_to(instance, filename):
    return _uuid_name("avatars/thumbs", filename)


def group_avatar_upload_to(instance, filename):
    return _uuid_name("groups", filename)


def group_avatar_thumb_upload_to(instance, filename):
    return _uuid_name("groups/thumbs", filename)


# --- processing --------------------------------------------------------------


def absolute_media_url(file_field, request=None):
    """The absolute URL for a media ``FileField``, or ``None`` if it's empty.

    Serializers use this so clients get a full ``http(s)://host/media/...`` URL
    (built from the current request) rather than a bare path — which matters
    when the API is on a different origin from the SPA.
    """
    if not file_field:
        return None
    url = file_field.url
    return request.build_absolute_uri(url) if request is not None else url


def _load_verified(upload):
    """Return a loaded Pillow image for a trusted-only-after-decoding upload.

    Raises ``serializers.ValidationError`` (→ HTTP 400) on anything that isn't a
    real image in the allow-list, or is over the size cap.
    """
    size = getattr(upload, "size", None)
    if size is not None and size > MAX_UPLOAD_BYTES:
        raise serializers.ValidationError(
            f"Image is too large (max {MAX_UPLOAD_BYTES // (1024 * 1024)} MB)."
        )

    # verify() detects truncated/corrupt data but leaves the image unusable, so
    # we open a second time for the actual work.
    try:
        upload.seek(0)
        Image.open(upload).verify()
        upload.seek(0)
        img = Image.open(upload)
        img.load()
    except (UnidentifiedImageError, OSError, ValueError):
        raise serializers.ValidationError(
            "That file isn't a valid image."
        ) from None

    if img.format not in ALLOWED_FORMATS:
        raise serializers.ValidationError(
            "Unsupported image type. Use JPEG, PNG, WebP or GIF."
        )
    return img


def _strip_and_encode(img):
    """Rebuild ``img`` from raw pixels (dropping all metadata) and encode it.

    Returns ``(ContentFile, ext)``. Images with transparency are saved as PNG to
    preserve the alpha channel; everything else becomes JPEG (smaller). The
    pixel rebuild is what guarantees no EXIF/GPS survives into the stored file.
    """
    has_alpha = img.mode in ("RGBA", "LA") or (
        img.mode == "P" and "transparency" in img.info
    )
    if has_alpha:
        img = img.convert("RGBA")
        fmt, ext, params = "PNG", ".png", {"optimize": True}
    else:
        img = img.convert("RGB")
        fmt, ext, params = "JPEG", ".jpg", {"quality": 85, "optimize": True}

    clean = Image.new(img.mode, img.size)
    clean.putdata(list(img.getdata()))

    buf = BytesIO()
    clean.save(buf, fmt, **params)
    return ContentFile(buf.getvalue()), ext


def process_image(upload, *, max_edge, thumb_edge, thumb_square=False):
    """Validate and process one uploaded image.

    Returns a dict with ``image``/``thumbnail`` (Django ``ContentFile``s ready to
    hand to an ``ImageField.save``), ``ext``, ``width`` and ``height`` (of the
    downscaled original). The original is bounded to ``max_edge`` on its longest
    side; the thumbnail to ``thumb_edge`` (centre-cropped square when
    ``thumb_square``, e.g. for avatars).
    """
    img = _load_verified(upload)
    # Honour the camera's rotation flag before we strip metadata, so a portrait
    # photo isn't stored on its side.
    img = ImageOps.exif_transpose(img)

    original = img.copy()
    original.thumbnail((max_edge, max_edge), Image.LANCZOS)  # only ever shrinks
    image_file, ext = _strip_and_encode(original)

    if thumb_square:
        thumb = ImageOps.fit(img, (thumb_edge, thumb_edge), Image.LANCZOS)
    else:
        thumb = img.copy()
        thumb.thumbnail((thumb_edge, thumb_edge), Image.LANCZOS)
    thumb_file, _ = _strip_and_encode(thumb)

    return {
        "image": image_file,
        "thumbnail": thumb_file,
        "ext": ext,
        "width": original.width,
        "height": original.height,
    }


# --- avatars -----------------------------------------------------------------
# One place for the avatar lifecycle, shared by user profiles (accounts) and
# groups (api). Both models expose ``avatar`` + ``avatar_thumb`` ImageFields, so
# these operate on any such ``instance`` — the sizing, the square thumbnail, and
# the "drop the old files so replaced avatars don't pile up on disk" rule can't
# drift between the two. None of these call ``instance.save()``; the caller
# persists (with the right ``update_fields``) so it composes with other updates.


def process_avatar(upload):
    """Validate + downscale + strip metadata from an avatar upload, using the
    shared avatar sizes and a centre-cropped square thumbnail. Returns the same
    dict as ``process_image``."""
    return process_image(
        upload,
        max_edge=AVATAR_MAX_EDGE,
        thumb_edge=AVATAR_THUMB_EDGE,
        thumb_square=True,
    )


def save_avatar(instance, processed):
    """Write a ``process_avatar`` result onto ``instance``'s avatar fields,
    dropping any old files first. Does not save the instance."""
    instance.avatar.delete(save=False)
    instance.avatar_thumb.delete(save=False)
    instance.avatar.save(
        f"avatar{processed['ext']}", processed["image"], save=False
    )
    instance.avatar_thumb.save(
        f"thumb{processed['ext']}", processed["thumbnail"], save=False
    )


def clear_avatar(instance):
    """Remove ``instance``'s avatar + thumbnail (files and fields). Does not save
    the instance."""
    instance.avatar.delete(save=False)
    instance.avatar_thumb.delete(save=False)
    instance.avatar = None
    instance.avatar_thumb = None
