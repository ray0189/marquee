"""External subtitles: list from the OpenSubtitles Stremio addon, serve as WebVTT.
The VTT proxy is the one route where bytes pass through us: text only, host allow-listed, size capped."""

import re
from urllib.parse import quote, urljoin, urlparse

from fastapi import HTTPException

from .config import cfg
from .http import client

ADDON = "https://opensubtitles-v3.strem.io"
MAX_BYTES = 2_000_000

LANGS = {
    "eng": "English", "spa": "Spanish", "fre": "French", "fra": "French", "ger": "German", "deu": "German",
    "ita": "Italian", "por": "Portuguese", "pob": "Portuguese (BR)", "ara": "Arabic", "rus": "Russian",
    "tur": "Turkish", "pol": "Polish", "dut": "Dutch", "nld": "Dutch", "hin": "Hindi", "jpn": "Japanese",
    "kor": "Korean", "chi": "Chinese", "zho": "Chinese", "zht": "Chinese (Trad.)", "swe": "Swedish",
    "nor": "Norwegian", "dan": "Danish", "fin": "Finnish", "gre": "Greek", "ell": "Greek", "heb": "Hebrew",
    "rum": "Romanian", "ron": "Romanian", "hun": "Hungarian", "cze": "Czech", "ces": "Czech", "urd": "Urdu",
    "ben": "Bengali", "ind": "Indonesian", "vie": "Vietnamese", "tha": "Thai", "ukr": "Ukrainian",
}


def host_allowed(url: str) -> bool:
    p = urlparse(url)
    if p.scheme != "https" or not p.hostname:
        return False
    allowed = [h.strip().lower() for h in cfg.subtitle_hosts.split(",") if h.strip()]
    host = p.hostname.lower()
    return any(host == a or host.endswith("." + a) for a in allowed)


_SOURCES = ("bluray", "bdrip", "brrip", "remux", "web", "webrip", "webdl", "hdtv", "dvd", "dvdrip", "hdrip")
_CUTS = ("extended", "imax", "directors", "unrated", "theatrical", "remastered", "uncut", "special")


def _tokens(s: str) -> set[str]:
    s = re.sub(r"web[ ._-]?dl", "webdl", (s or "").lower())
    return {t for t in re.split(r"[^a-z0-9]+", s) if t}


def match_score(sub: dict, filename: str) -> int:
    """How likely a subtitle is timed for this exact file. Same release group, source and cut means the same
    encode, which is what keeps subtitles in sync; a different cut (extended vs theatrical) almost never is."""
    if not filename:
        return 0
    want = _tokens(filename)
    have = _tokens(f"{sub.get('movieReleaseName', '')} {sub.get('subtitleFileName', '')}")
    group = re.search(r"-([a-z0-9]+)(?:\.[a-z0-9]{2,4})?$", filename.lower())
    s = 0
    if group and group.group(1) in have:
        s += 6
    s += 3 * len(want & have & set(_SOURCES))
    for cut in _CUTS:
        if (cut in want) != (cut in have):
            s -= 3
        elif cut in want:
            s += 2
    s += len(want & have & {"2160p", "1080p", "720p", "x264", "x265", "h264", "h265", "hevc"})
    return s


async def list_for(imdb: str, media_type: str, season: int | None, episode: int | None, filename: str = "") -> list[dict]:
    path = f"/subtitles/movie/{imdb}.json" if media_type == "movie" else f"/subtitles/series/{imdb}:{season}:{episode}.json"
    try:
        r = await client().get(ADDON + path, timeout=6)
        r.raise_for_status()
        subs = r.json().get("subtitles", [])
    except Exception:
        return []
    # Best match for the playing file first within each language, up to 5 per language to try if one is off.
    subs = sorted((s for s in subs if s.get("url") and host_allowed(s["url"])), key=lambda s: -match_score(s, filename))
    per_lang: dict[str, int] = {}
    out = []
    for s in subs:
        lang = s.get("lang", "")
        n = per_lang.get(lang, 0)
        if n >= 5:
            continue
        per_lang[lang] = n + 1
        name = LANGS.get(lang, lang.upper())
        label = name if n == 0 else f"{name} ({n + 1})"
        if n == 0 and match_score(s, filename) >= 6:
            label += " · matches this file"
        out.append({"id": s.get("id"), "lang": lang, "label": label, "url": "/api/subs/vtt?u=" + quote(s["url"], safe="")})
    out.sort(key=lambda s: (s["lang"] != "eng", s["lang"]))  # stable: keeps each language's best match first
    return out[:20]


_TS = re.compile(r"(\d{1,2}):(\d{2}):(\d{2})\.(\d{3})")


def shift_vtt(text: str, seconds: float) -> str:
    """Move every cue by `seconds` (positive = later), clamped at zero."""
    if not seconds:
        return text

    def move(m: re.Match) -> str:
        t = int(m[1]) * 3600 + int(m[2]) * 60 + int(m[3]) + int(m[4]) / 1000 + seconds
        t = max(0.0, t)
        ms = round(t * 1000)
        return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d}.{ms % 1000:03d}"

    return "\n".join(_TS.sub(move, line) if "-->" in line else line for line in text.split("\n"))


def srt_to_vtt(text: str) -> str:
    text = text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    if text.startswith("WEBVTT"):
        return text
    text = re.sub(r"(\d{1,2}:\d{2}:\d{2}),(\d{3})", r"\1.\2", text)
    text = re.sub(r"</?font[^>]*>", "", text)
    return "WEBVTT\n\n" + text.strip() + "\n"


def _decode(raw: bytes) -> str:
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


async def fetch_vtt(url: str) -> str:
    if not host_allowed(url):
        raise HTTPException(400, {"code": "HOST", "message": "Subtitle host not allowed"})
    for _ in range(4):  # follow redirects by hand so every hop stays on the allow-list
        async with client().stream("GET", url, timeout=10) as r:
            if r.status_code in (301, 302, 303, 307, 308):
                url = str(r.next_request.url) if r.next_request else urljoin(url, r.headers.get("location", ""))
                if not host_allowed(url):
                    raise HTTPException(400, {"code": "HOST", "message": "Redirect left the allowed hosts"})
                continue
            if r.status_code >= 400:
                raise HTTPException(502, {"code": "UPSTREAM", "message": f"Subtitle host answered {r.status_code}"})
            # Read with a cap instead of trusting Content-Length, so a huge file never lands in memory.
            raw = bytearray()
            async for chunk in r.aiter_bytes():
                raw += chunk
                if len(raw) > MAX_BYTES:
                    raise HTTPException(413, {"code": "TOO_BIG", "message": "Subtitle file too large"})
        return srt_to_vtt(_decode(bytes(raw)))
    raise HTTPException(502, {"code": "REDIRECTS", "message": "Too many redirects"})
