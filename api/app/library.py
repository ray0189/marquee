"""Index of the owner's TorBox library, kept in Redis by the worker.
Request paths only read this index; they never call mylist."""

import json
import re
import time

from . import torbox
from .indexers import Candidate
from .rds import redis
from .adult import is_adult
from .release import is_video, pick_file


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def _slim(item: dict) -> dict | None:
    files = [
        {"id": f["id"], "name": f.get("name") or f.get("short_name") or "", "size": f.get("size") or 0}
        for f in item.get("files") or []
        if "id" in f and is_video(f)
    ]
    if not files or not item.get("hash"):
        return None
    return {"id": item["id"], "hash": str(item["hash"]).lower(), "name": item.get("name") or "", "size": item.get("size") or 0, "files": files}


async def sync() -> dict:
    items = [s for it in await torbox.mylist_all() if (s := _slim(it))]
    if not items:
        # One empty answer may be a TorBox hiccup; two in a row means the library really is empty, and a stale
        # index would keep offering files that no longer exist.
        if await redis.incr("lib:empty_runs") < 2:
            return {"items": 0, "kept_old_index": True}
        await clear()
        return {"items": 0, "cleared": True}
    await redis.delete("lib:empty_runs")
    for k in ("lib:items:new", "lib:hashes:new"):
        await redis.delete(k)
    for i in range(0, len(items), 300):
        chunk = items[i : i + 300]
        await redis.hset("lib:items:new", mapping={str(x["id"]): json.dumps(x) for x in chunk})
        await redis.hset("lib:hashes:new", mapping={x["hash"]: str(x["id"]) for x in chunk})
    names = [[x["id"], x["hash"], norm(x["name"]), x["size"]] for x in items]
    pipe = redis.pipeline()
    pipe.rename("lib:items:new", "lib:items")
    pipe.rename("lib:hashes:new", "lib:hashes")
    pipe.set("lib:names", json.dumps(names))
    pipe.set("lib:synced_at", str(int(time.time())))
    await pipe.execute()
    return {"items": len(items)}


async def clear() -> None:
    await redis.delete("lib:items", "lib:hashes", "lib:names", "lib:synced_at")


async def stats() -> dict:
    n = await redis.hlen("lib:hashes")
    at = await redis.get("lib:synced_at")
    return {"items": n, "synced_at": int(at) if at else None}


async def item_by_hash(h: str) -> dict | None:
    tid = await redis.hget("lib:hashes", h.lower())
    if not tid:
        return None
    raw = await redis.hget("lib:items", tid)
    return json.loads(raw) if raw else None


async def put_item(item: dict) -> dict | None:
    slim = _slim(item)
    if slim:
        await redis.hset("lib:items", str(slim["id"]), json.dumps(slim))
        await redis.hset("lib:hashes", slim["hash"], str(slim["id"]))
    return slim


async def match(title: str, year: int | None, media_type: str, season: int | None, episode: int | None) -> list[Candidate]:
    """Find library torrents for a title by name, then confirm the episode inside the pack."""
    raw = await redis.get("lib:names")
    if not raw or not title:
        return []
    t = norm(title)
    out: list[Candidate] = []
    for tid, h, name, size in json.loads(raw):
        if not (name == t or name.startswith(t + " ")):
            continue
        if media_type == "movie":
            if year and not any(str(y) in name.split() for y in (year - 1, year, year + 1)):
                continue
        item = await item_by_hash(h)
        if not item or is_adult(item["name"], title):  # porn parodies reuse real titles and years
            continue
        if media_type == "tv" and not pick_file(item["files"], season, episode):
            continue
        out.append(Candidate(hash=h, title=item["name"], size=size, seeders=0, indexers={"library"}, cached=True, owned=True))
        if len(out) >= 8:
            break
    return out
