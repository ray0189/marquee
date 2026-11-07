"""Release-name parsing and ranking. Everything here is pure (no I/O) so it is easy to test."""

import math
import re
import unicodedata
from dataclasses import asdict, dataclass, field

from .adult import is_adult

VIDEO_EXT = {".mkv", ".mp4", ".m4v", ".avi", ".mov", ".webm", ".wmv", ".ts", ".m2ts", ".mpg", ".mpeg"}
_EXT_RE = re.compile(r"\.(mkv|mp4|m4v|avi|mov|webm|wmv|m2ts|ts|mpg|mpeg)$", re.I)


@dataclass
class Release:
    resolution: int = 0
    source: str = ""
    codec: str = ""
    hdr: list[str] = field(default_factory=list)
    audio: list[str] = field(default_factory=list)
    container: str = ""
    flags: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def _has(s: str, pattern: str) -> bool:
    # Group the alternation so the boundaries apply to every branch, and let an optional
    # space also be a hyphen (WEB-DL, Blu-ray, DTS-HD).
    pattern = pattern.replace(" ?", "[ -]?")
    return re.search(rf"(?<![a-z0-9])(?:{pattern})(?![a-z0-9])", s) is not None


def parse(*names: str) -> Release:
    """Parse one or more names (torrent title, file name) into a single Release."""
    r = Release()
    texts = []
    for n in names:
        if not n:
            continue
        m = _EXT_RE.search(n.strip())
        if m and not r.container:
            r.container = m.group(1).lower()
        base = _EXT_RE.sub("", n.strip()) if m else n
        texts.append(re.sub(r"[._\[\]()]", " ", base.lower()))
    s = " ".join(texts)
    if not s:
        return r

    if _has(s, r"2160p|2160|4k|uhd"):
        r.resolution = 2160
    elif _has(s, r"1080p|1080i|1080"):
        r.resolution = 1080
    elif _has(s, r"720p|720"):
        r.resolution = 720
    elif _has(s, r"480p|576p|480i"):
        r.resolution = 480

    if _has(s, r"remux|bd ?remux"):
        r.source = "remux"
    elif _has(s, r"blu ?ray|bdrip|brrip|bd ?rip"):
        r.source = "bluray"
    elif _has(s, r"web ?dl|webdl"):
        r.source = "web-dl"
    elif _has(s, r"web ?rip"):
        r.source = "webrip"
    elif _has(s, r"hdtv|pdtv|dsr"):
        r.source = "hdtv"
    elif _has(s, r"dvd ?rip|dvdr|dvd"):
        r.source = "dvd"

    if _has(s, r"hevc|x ?265|h ?265"):
        r.codec = "hevc"
    elif _has(s, r"av1"):
        r.codec = "av1"
    elif _has(s, r"x ?264|h ?264|avc"):
        r.codec = "avc"
    elif _has(s, r"xvid|divx"):
        r.codec = "mpeg4"

    if _has(s, r"dv|dovi|dolby ?vision"):
        r.hdr.append("DV")
    if _has(s, r"hdr10\+|hdr10plus"):
        r.hdr.append("HDR10+")
    elif _has(s, r"hdr10|hdr"):
        r.hdr.append("HDR")

    for tag, pat in [
        ("truehd", r"true ?hd"),
        ("dtsx", r"dts ?x"),
        ("dtshd", r"dts ?hd(?: ?ma)?"),
        ("dts", r"dts"),
        ("atmos", r"atmos"),
        ("eac3", r"e ?ac ?3|ddp(?:\d ?\d)?|dd\+(?:\d ?\d)?"),
        ("ac3", r"ac ?3|dd ?\d ?\d|dolby ?digital"),
        ("aac", r"aac(?:\d ?\d)?"),
        ("opus", r"opus"),
        ("flac", r"flac"),
        ("mp3", r"mp3"),
    ]:
        if _has(s, pat):
            r.audio.append(tag)

    if not r.container:
        for c in ("mkv", "mp4", "avi"):
            if _has(s, c):
                r.container = c
                break

    for flag, pat in [
        ("cam", r"cam|hdcam|cam ?rip"),
        ("ts", r"telesync|tele ?sync|hdts|ts|pdvd"),
        ("tc", r"telecine|hdtc|tc"),
        ("scr", r"scr|screener|dvd ?scr"),
        ("r5", r"r5"),
        ("workprint", r"workprint|wp"),
        ("3d", r"3d|h ?sbs|half ?sbs|full ?sbs|sbs|h ?ou|half ?ou|hou"),
    ]:
        if _has(s, pat):
            r.flags.append(flag)
    return r


_RES = {2160: 400, 1080: 300, 720: 150, 480: 50}
_SRC = {"remux": 120, "bluray": 100, "web-dl": 90, "webrip": 70, "hdtv": 40, "dvd": 20}
_CODEC = {"hevc": 15, "av1": 10, "avc": 12}


def is_blocked(rel: Release, q: dict) -> bool:
    # 3D (side-by-side / over-under) shows two squashed pictures in a browser: never useful here.
    return "3d" in rel.flags or any(f in q["blocked"] for f in rel.flags)


def passes(rel: Release, q: dict) -> bool:
    return rel.resolution == 0 or rel.resolution >= q["min_resolution"]


def score(rel: Release, *, seeders: int, cached: bool, owned: bool, q: dict) -> int:
    pts = _RES.get(rel.resolution, 20) + _SRC.get(rel.source, 30) + _CODEC.get(rel.codec, 0)
    if q["prefer_hdr"] and rel.hdr:
        pts += 10
    if any(a in rel.audio for a in ("atmos", "truehd", "dtshd", "dtsx")):
        pts += 3
    # Playback is in a browser: files that play directly start instantly and seek natively.
    friendly = 0
    if rel.container in ("mp4", "m4v", "webm"):
        friendly += 20
    if rel.codec == "avc":
        friendly += 10
    if any(a in rel.audio for a in ("aac", "opus")):
        friendly += 8
    pts += int(friendly * q["browser_bias"] / 50)
    pts += min(int(math.log2(seeders + 1) * 5), 40)
    if cached:
        pts += 1000
    if owned:
        pts += 200
    return pts


def is_video(f: dict) -> bool:
    name = (f.get("name") or f.get("short_name") or "").lower()
    ext = "." + name.rsplit(".", 1)[-1] if "." in name else ""
    return ext in VIDEO_EXT or str(f.get("mimetype", "")).startswith("video/")


_STOP = {"the", "a", "an", "of", "and", "part"}


def _words(s: str) -> list[str]:
    # Fold accents (Léon -> leon, TÁR -> tar) and drop apostrophes (Cuckoo's -> cuckoos) before splitting.
    s = unicodedata.normalize("NFKD", s.lower())
    s = "".join(c for c in s if not unicodedata.combining(c)).replace("'", "").replace("\u2019", "")
    return [w for w in re.sub(r"[^a-z0-9]+", " ", s).split() if w not in _STOP]


def _film_match(name: str, title: str, year: int | None) -> int:
    """How well a file path matches a film: all title words present, then the right year. <0 = another film."""
    have = set(_words(name))
    want = _words(title)
    if not want or not all(w in have for w in want):
        return -1
    years = {int(y) for y in re.findall(r"(?<!\d)(19\d\d|20\d\d)(?!\d)", name)}
    if year and years:
        return 3 if year in years else -1  # "The Avengers 2012" isn't "Age of Ultron 2015"
    return 2


def _pick_film(vids: list[dict], size, title: str | None, year: int | None) -> dict | None:
    """One film's file. A single big video is the film. In a pack, match each file's OWN name (folder names like
    "Dark Knight Trilogy 2005-2008-2012" would match every film in it), then fall back to the one file carrying
    the film's year (packs with translated titles). Refuse rather than play another film."""
    films = [f for f in vids if size(f) >= 200_000_000] or vids  # extras and featurettes are small
    if len(films) <= 1 or not title:
        return max(vids, key=size)
    base = lambda f: (f.get("name") or "").rsplit("/", 1)[-1]  # noqa: E731
    scored = [(_film_match(base(f), title, year), f) for f in films]
    best = max(scored, key=lambda t: (t[0], -abs(len(_words(base(t[1]))) - len(_words(title))), size(t[1])))
    if best[0] > 0:
        return best[1]
    if year:
        dated = [f for f in films if re.search(rf"(?<!\d){year}(?!\d)", base(f))]
        # Several files with the year but the same title before it (1080p + 720p of one film): the biggest.
        lead = {" ".join(_words(re.split(rf"(?<!\d){year}(?!\d)", base(f))[0])) for f in dated}
        if len(dated) == 1 or (len(dated) > 1 and len(lead) == 1 and "" not in lead):
            return max(dated, key=size)
    ranked = sorted(films, key=size, reverse=True)
    if size(ranked[0]) >= size(ranked[1]) * 5:  # a disc's main stream next to its extras
        return ranked[0]
    if len(ranked) <= 3 and size(ranked[1]) < size(ranked[0]) * 0.4:  # one film plus a couple of big extras
        return ranked[0]
    leads = {" ".join(_words(base(f))[:3]) for f in films}
    if len(leads) == 1 and "" not in leads:  # same title on every file: versions of one film (1080p + 480p)
        return ranked[0]
    return None


def pick_file(files: list[dict], season: int | None = None, episode: int | None = None,
              title: str | None = None, year: int | None = None) -> dict | None:
    """Pick the right file inside a torrent. Never trusts an indexer's file index.

    For a film, a collection pack ("Marvel Films 2008-2021") holds many full-length films: pick the one whose
    name matches the title and year, and refuse to guess when none does (the biggest file is another film)."""
    size = lambda f: f.get("size") or 0  # noqa: E731
    vids = [f for f in files if is_video(f)]
    if not vids:
        return None
    biggest = max(size(f) for f in vids)

    def is_sample(f: dict) -> bool:
        # A sample lives in a sample/ folder, or is a tiny file with 'sample' in its own name.
        # (Not 'sample' anywhere in the path: a title can legitimately contain the word.)
        parts = (f.get("name") or "").lower().split("/")
        if any(p in ("sample", "samples") for p in parts[:-1]):
            return True
        return bool(re.search(r"(?<![a-z0-9])sample(?![a-z0-9])", parts[-1])) and size(f) < biggest * 0.1

    vids = [f for f in vids if not is_sample(f)] or vids
    vids = [f for f in vids if not is_adult(f.get("name") or "", title or "")]  # porn parodies inside packs
    if not vids:
        return None
    if season is None or episode is None:
        return _pick_film(vids, size, title, year)
    pats = [
        rf"s0*{season}(?:[ ._-]*e\d+)*[ ._-]*e0*{episode}(?!\d)",
        rf"(?<!\d)0*{season}x0*{episode}(?!\d)",
        rf"season[ ._-]*0*{season}[^\n]*?episode[ ._-]*0*{episode}(?!\d)",
    ]
    hits = [f for f in vids if any(re.search(p, (f.get("name") or "").lower()) for p in pats)]
    if hits:
        return max(hits, key=size)
    return vids[0] if len(vids) == 1 else None
