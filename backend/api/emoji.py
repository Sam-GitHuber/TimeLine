"""Server-side emoji validation for reactions (Phase 7b).

A reaction stores a single emoji as a Unicode string. The frontend picker only
ever emits real emoji, but the API must never trust the client — an attacker can
POST any string — so we validate/normalise here before a ``Reaction`` row is
written.

Deliberately **dependency-free** (stdlib only), to stay consistent with the
app's self-hosted / no-extra-machinery stance. That means this is a *heuristic*,
not a perfect Unicode-Emoji-property oracle: we allow the code points that make
up emoji (the pictographic ranges plus the joiners/modifiers that combine them)
and reject everything else (letters, whitespace, control chars, markup). Its job
is to bound abuse — arbitrary text, oversized ZWJ chains, injected markup — not
to adjudicate every edge of the emoji standard. A newly-assigned emoji outside
these ranges would be rejected; widen the ranges if that ever bites.
"""

import unicodedata

# An emoji "reaction" is one grapheme, but a single emoji can be several code
# points (a ZWJ family, a skin-toned profession, a flag). Cap the count so a
# crafted ZWJ chain can't bloat a row, with headroom for the longest real
# sequences (e.g. a 4-person family = 4 bases + 3 joiners = 7).
MAX_EMOJI_CODEPOINTS = 12

# The most distinct emoji one user may put on a single target — bounds spam
# without getting in the way of genuine use.
MAX_REACTIONS_PER_USER_PER_TARGET = 20

# Individual code points that are *components* of an emoji rather than emoji in
# their own right: zero-width joiner, variation selectors (text/emoji
# presentation), the combining enclosing keycap, and the Fitzpatrick skin-tone
# modifiers. Allowed only as part of a sequence, never on their own.
_ZWJ = 0x200D
_VS15 = 0xFE0E  # text presentation
_VS16 = 0xFE0F  # emoji presentation
_KEYCAP = 0x20E3
_SKIN_TONES = range(0x1F3FB, 0x1F400)
_COMPONENTS = {_ZWJ, _VS15, _VS16, _KEYCAP} | set(_SKIN_TONES)

# The bases that only form an emoji *with* the keycap combiner — '#', '*', 0-9.
# On their own they're just an ASCII char/digit ("123" is not a reaction), so
# they count as an emoji base only when the string also carries U+20E3.
_KEYCAP_BASES = {0x0023, 0x002A} | set(range(0x0030, 0x003A))

# Code points that count as an emoji "base" — at least one is required, so a
# string of only joiners/modifiers (or a bare digit) is rejected. Covers the
# pictographic blocks plus the scattered older symbols/dingbats and the ASCII
# keycap bases (#, *, 0-9, which only form an emoji with the keycap combiner).
_EMOJI_BASE_RANGES = (
    (0x1F300, 0x1F5FF),  # Misc Symbols and Pictographs
    (0x1F600, 0x1F64F),  # Emoticons
    (0x1F680, 0x1F6FF),  # Transport and Map
    (0x1F900, 0x1F9FF),  # Supplemental Symbols and Pictographs
    (0x1FA70, 0x1FAFF),  # Symbols and Pictographs Extended-A
    (0x1F1E6, 0x1F1FF),  # Regional Indicators (flags)
    (0x1F000, 0x1F0FF),  # Mahjong/Dominoes/Playing cards
    (0x1F100, 0x1F2FF),  # Enclosed Alphanumeric/Ideographic Supplement
    (0x2600, 0x26FF),  # Misc Symbols
    (0x2700, 0x27BF),  # Dingbats
    (0x2300, 0x23FF),  # Misc Technical (⌚⏰⏳…)
    (0x2B00, 0x2BFF),  # Misc Symbols and Arrows (⭐⬛…)
    (0x2190, 0x21FF),  # Arrows
    (0x2000, 0x206F),  # General Punctuation (‼️ … with VS16)
    (0x2100, 0x214F),  # Letterlike Symbols (™️ ℹ️)
    (0x00A9, 0x00A9),  # ©
    (0x00AE, 0x00AE),  # ®
)


class InvalidEmoji(ValueError):
    """Raised when a reaction string isn't an acceptable single emoji."""


def _is_base(cp):
    return any(lo <= cp <= hi for lo, hi in _EMOJI_BASE_RANGES)


def normalise_emoji(raw):
    """Normalise and validate a reaction emoji, returning the canonical string.

    Raises :class:`InvalidEmoji` (a ``ValueError``) with a user-facing message if
    the input isn't an acceptable single emoji. Callers in the view layer turn
    that into a DRF 400.
    """
    if not isinstance(raw, str):
        raise InvalidEmoji("A reaction must be a single emoji.")

    # NFC so equivalent encodings collapse to one canonical form — otherwise the
    # same visible emoji could be stored (and counted) as two different strings.
    emoji = unicodedata.normalize("NFC", raw).strip()

    if not emoji:
        raise InvalidEmoji("A reaction can't be empty.")

    code_points = [ord(ch) for ch in emoji]
    if len(code_points) > MAX_EMOJI_CODEPOINTS:
        raise InvalidEmoji("That's not a single emoji.")

    has_keycap = _KEYCAP in code_points
    has_base = False
    for cp in code_points:
        if cp in _COMPONENTS:
            continue
        if cp in _KEYCAP_BASES:
            # A digit/#/* is an emoji base only as part of a keycap (e.g. 1️⃣);
            # bare "123" is not a reaction.
            if not has_keycap:
                raise InvalidEmoji("Reactions can only be emoji.")
            has_base = True
            continue
        if _is_base(cp):
            has_base = True
            continue
        # Anything else — a letter, space, control char, or stray markup — means
        # this isn't a plain emoji. Reject the whole string.
        raise InvalidEmoji("Reactions can only be emoji.")

    if not has_base:
        # Only joiners/modifiers (or nothing that stands alone) — not an emoji.
        raise InvalidEmoji("That's not a valid emoji.")

    return emoji
