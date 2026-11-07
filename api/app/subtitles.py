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


async def list_for(imdb: str, media_type: str, season: int | None, episode: int | None) -> list[dict]:
    path = f"/subtitles/movie/{imdb}.json" if media_type == "movie" else f"/subtitles/series/{imdb}:{season}:{episode}.json"
    try:
        r = await client().get(ADDON + path, timeout=6)
        r.raise_for_status()
        subs = r.json().get("subtitles", [])
    except Exception:
        return []
    per_lang: dict[str, int] = {}
    out = []
    for s in subs:
        lang, url = s.get("lang", ""), s.get("url", "")
        if not url or not host_allowed(url) or per_lang.get(lang, 0) >= 2:
            continue
        per_lang[lang] = per_lang.get(lang, 0) + 1
        out.append({"id": s.get("id"), "lang": lang, "label": LANGS.get(lang, lang.upper()), "url": "/api/subs/vtt?u=" + quote(url, safe="")})
    out.sort(key=lambda s: (s["lang"] != "eng", s["label"]))
    return out[:14]


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
