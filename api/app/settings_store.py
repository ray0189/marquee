"""Runtime settings kept in the database (secrets encrypted), with a short in-process cache."""

import json
import time
from typing import Any
from urllib.parse import urlparse

from pydantic import BaseModel, Field
from sqlalchemy import delete

from .config import cfg
from .db import SessionLocal
from .models import Setting
from .security import decrypt, encrypt

_TTL = 20.0
_cache: dict[str, tuple[float, Any, str]] = {}


async def _bump() -> None:
    from .rds import redis

    try:
        await redis.incr("settings:version")
    except Exception:  # noqa: BLE001
        pass


class Quality(BaseModel):
    cached_only: bool = True
    allow_uncached_add: bool = False
    min_resolution: int = Field(720, ge=0, le=2160)
    blocked: list[str] = ["cam", "ts", "tc", "scr", "r5", "workprint"]
    browser_bias: int = Field(50, ge=0, le=100)
    prefer_hdr: bool = False
    max_results: int = Field(60, ge=5, le=200)
    english_only: bool = False  # drop releases in other languages (falls back when a title has no English one)


class Indexer(BaseModel):
    name: str = Field(min_length=1, max_length=40, pattern=r"^[A-Za-z0-9 ._-]+$")
    url: str
    enabled: bool = True
    timeout: float = Field(8.0, ge=2, le=20)


def default_indexers() -> list[dict]:
    out = []
    for raw in cfg.indexer_urls.split(","):
        raw = raw.strip()
        if not raw:
            continue
        parts = urlparse(raw).netloc.split(".")
        host = parts[0] or "indexer"
        if any(o["name"] == host for o in out) and len(parts) > 1:  # two instances of one addon
            host = f"{host}-{parts[1]}"
        out.append(Indexer(name=host, url=raw, timeout=6.0 if host == "torrentio" else 8.0).model_dump())
    return out


async def _read(key: str) -> str | None:
    async with SessionLocal() as s:
        row = await s.get(Setting, key)
        return row.value if row else None


async def _version() -> str:
    """Bumped in Redis on every write, so every process (two API workers + the worker) drops its cache at once."""
    from .rds import redis

    try:
        return (await redis.get("settings:version")) or "0"
    except Exception:  # noqa: BLE001  (Redis down: fall back to the time-based expiry)
        return "?"


async def get(key: str, default: Any = None) -> Any:
    hit = _cache.get(key)
    ver = await _version()
    if hit and time.time() - hit[0] < _TTL and (ver == "?" or hit[2] == ver):
        return hit[1]
    raw = await _read(key)
    if raw is None:
        val = default
    else:
        val = json.loads(raw)
        if isinstance(val, str) and val.startswith("enc:"):
            try:
                val = decrypt(val[4:])
            except Exception:
                val = default
    _cache[key] = (time.time(), val, ver)
    return val


async def put(key: str, value: Any, secret: bool = False) -> None:
    stored = json.dumps("enc:" + encrypt(value) if secret else value)
    async with SessionLocal() as s:
        row = await s.get(Setting, key)
        if row:
            row.value = stored
        else:
            s.add(Setting(key=key, value=stored))
        await s.commit()
    await _bump()
    _cache.pop(key, None)


async def remove(key: str) -> None:
    async with SessionLocal() as s:
        await s.execute(delete(Setting).where(Setting.key == key))
        await s.commit()
    await _bump()
    _cache.pop(key, None)


async def torbox_key() -> str:
    return (await get("torbox_key")) or cfg.torbox_api_key


async def tmdb_key() -> str:
    return (await get("tmdb_key")) or cfg.tmdb_api_key


async def quality() -> dict:
    return Quality(**((await get("quality")) or {})).model_dump()


async def indexers() -> list[dict]:
    return (await get("indexers")) or default_indexers()
