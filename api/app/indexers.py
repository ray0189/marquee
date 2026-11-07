"""Stremio-style stream indexers (Torrentio, Knightcrawler, …) queried in parallel."""

import json
import re
import time
from dataclasses import dataclass, field

from .http import client
from .rds import redis


@dataclass
class Candidate:
    hash: str
    title: str = ""
    filename: str = ""
    size: int = 0
    seeders: int = 0
    indexers: set[str] = field(default_factory=set)
    cached: bool | None = None
    owned: bool = False

    def merge(self, other: "Candidate") -> None:
        self.indexers |= other.indexers
        self.seeders = max(self.seeders, other.seeders)
        self.size = max(self.size, other.size)
        self.filename = self.filename or other.filename
        self.title = self.title or other.title


_SIZE = re.compile(r"([\d.]+)\s*(TB|GB|MB)", re.I)
_UNIT = {"mb": 1_000_000, "gb": 1_000_000_000, "tb": 1_000_000_000_000}


def _parse_size(text: str) -> int:
    m = _SIZE.search(text)
    return int(float(m.group(1)) * _UNIT[m.group(2).lower()]) if m else 0


def _title(text: str) -> str:
    """Release name from a stream's text. Most addons put it on the first line; Comet and StremThru mark it
    with 📄 (Torz puts quality badges first), so prefer that line."""
    lines = [l.strip() for l in text.split("\n") if l.strip()]
    for l in lines:
        if l.startswith("📄"):
            return l.removeprefix("📄").strip()
    return lines[0] if lines else ""


def parse_streams(data: dict, name: str) -> list[Candidate]:
    out = []
    for s in data.get("streams", []) or []:
        h = str(s.get("infoHash") or "").lower()
        if len(h) != 40:
            continue
        text = s.get("title") or s.get("description") or ""
        bh = s.get("behaviorHints") or {}
        seeders = re.search(r"👤\s*(\d+)", text)
        out.append(
            Candidate(
                hash=h,
                title=_title(text),
                filename=bh.get("filename") or "",
                size=int(bh.get("videoSize") or 0) or _parse_size(text),
                seeders=int(seeders.group(1)) if seeders else 0,
                indexers={name},
            )
        )
    return out


async def _pause(name: str, e: Exception) -> None:
    """Back off an indexer in proportion to what went wrong. One slow or failed answer doesn't remove a source
    for everyone (3 in a row do); a rate limit is honoured for as long as the indexer asks."""
    resp = getattr(e, "response", None)
    status = getattr(resp, "status_code", None)
    if status == 429:
        try:
            wait = int(resp.headers.get("retry-after", "600"))
        except ValueError:
            wait = 600
        await redis.set(f"ix:down:{name}", "1", ex=max(60, min(wait, 1800)))
    elif "moved or shut down" in str(e):
        await redis.set(f"ix:down:{name}", "1", ex=3600)
    else:
        fails = await redis.incr(f"ix:fails:{name}")
        await redis.expire(f"ix:fails:{name}", 300)
        if fails >= 3:
            await redis.set(f"ix:down:{name}", "1", ex=300)


async def fetch(ix: dict, media_type: str, imdb: str, season: int | None, episode: int | None) -> list[Candidate]:
    name = ix["name"]
    if await redis.exists(f"ix:down:{name}"):
        return []  # circuit open: this indexer is paused (see _pause)
    path = f"/stream/movie/{imdb}.json" if media_type == "movie" else f"/stream/series/{imdb}:{season}:{episode}.json"
    started = time.monotonic()
    try:
        r = await client().get(ix["url"].rstrip("/") + path, timeout=ix.get("timeout", 8))
        if r.is_redirect:
            # Addons that shut down tend to redirect to a docs page; say so instead of a bare 3xx.
            raise RuntimeError(f"indexer moved or shut down (redirects to {r.headers.get('location', '?')})")
        r.raise_for_status()
        res = parse_streams(r.json(), name)
    except Exception as e:
        await _pause(name, e)
        await redis.set(f"ix:last:{name}", json.dumps({"ok": False, "ms": int((time.monotonic() - started) * 1000), "count": 0, "at": time.time()}), ex=86400)
        raise
    await redis.delete(f"ix:fails:{name}")
    await redis.set(f"ix:last:{name}", json.dumps({"ok": True, "ms": int((time.monotonic() - started) * 1000), "count": len(res), "at": time.time()}), ex=86400)
    return res
