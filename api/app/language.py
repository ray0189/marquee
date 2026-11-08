"""English-only filtering for release names, and picking the English track from a list of audio tracks.

A release is treated as English unless its name says otherwise: another script (Cyrillic, CJK, Arabic, ...) or a
foreign-language tag (ITA, FRENCH, RUS, LATINO, DUBLADO, ...) with no sign of English (ENG, ENGLISH, MULTi).
English releases are normally untagged, so "no tag" means English."""

import re
import unicodedata

_OTHER_SCRIPT = re.compile(
    "[Ѐ-ӿ֐-׿؀-ۿऀ-෿฀-๿぀-ヿ㐀-鿿가-힯]"
)
_ENGLISH = re.compile(r"(?<![a-z])(?:eng|english|multi|multi ?subs? ?eng)(?![a-z])")
_FOREIGN = re.compile(
    r"(?<![a-z])(?:"
    r"ita|italian|italiano|french|truefrench|vff|vfq|vf2|vfi|vostfr|german|deutsch|ger|"
    r"spanish|spa|castellano|latino|esp|espanol|rus|russian|ukr|ukrainian|"
    r"hindi|tamil|telugu|malayalam|kannada|bengali|punjabi|marathi|"
    r"portuguese|por|dublado|dual ?audio ?pt|ptbr|pt ?br|polish|pol|pl|lektor|czech|cze|hun|hungarian|"
    r"turkish|arabic|persian|farsi|hebrew|greek|dutch|nl|swedish|swe|norwegian|danish|"
    r"finnish|korean|kor|japanese|jpn|chinese|chs|cht|mandarin|cantonese|thai|vietnamese|"
    r"indonesian|filipino|tagalog|romanian|bulgarian|serbian|croatian|slovak|slovenian"
    r")(?![a-z])"
)


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", (s or "").lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", " ", s)


def is_english(*names: str, title: str = "") -> bool:
    """`title`: the film's own title; its words never count as a language tag ("Chi-Raq", "The Italian Job")."""
    raw = " ".join(n or "" for n in names)
    text = _norm(raw)
    if _ENGLISH.search(text):
        return True
    if _OTHER_SCRIPT.search(raw) and not _OTHER_SCRIPT.search(title or ""):
        return False
    allowed = set(_norm(title).split())
    return not any(m.group(0) not in allowed for m in _FOREIGN.finditer(text))


def english_track(tracks: list[dict]) -> int | None:
    """Index of the first English audio track in TorBox's stream metadata, or None if none looks English."""
    for i, t in enumerate(tracks or []):
        if not isinstance(t, dict):
            continue
        words = " ".join(str(t.get(k) or "") for k in ("language", "lang", "language_code", "title", "label", "name")).lower()
        if re.search(r"(?<![a-z])(?:en|eng|english)(?![a-z])", words):
            return i
    return None
