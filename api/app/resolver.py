"""Title -> ranked, playable sources. Yields events for Server-Sent Events:
start, indexer, streams (interim/final), warning, error, done."""

import asyncio
import json
import logging
import re
import time
from collections.abc import AsyncIterator

from .adult import is_adult
from .language import is_english
from . import indexers as ix_mod, library, settings_store as store, torbox
from .indexers import Candidate
from .rds import redis
from .release import browser_friendly, is_blocked, parse, passes, pick_file, score

log = logging.getLogger("marquee.resolver")
CACHE_VERSION = "v8"  # v7: English-only option; v6: adult releases filtered (v3: releases that say they are a different film)

# Same-name releases that announce they aren't the film the IMDb id points at, e.g. "(NOT The Chris Nolan FILM)".
_NOT_THIS = re.compile(r"\bnot[\s._-]+the[\s._-]+[\w'.-]+(?:[\s._-]+[\w'.-]+){0,3}?[\s._-]+(?:film|movie)\b", re.I)


def to_item(c: Candidate, q: dict) -> dict:
    rel = parse(c.title, c.filename)
    return {
        "hash": c.hash,
        "title": c.title or c.filename,
        "size": c.size,
        "seeders": c.seeders,
        "cached": bool(c.cached),
        "owned": c.owned,
        "indexers": sorted(c.indexers),
        "release": rel.to_dict(),
        "score": score(rel, seeders=c.seeders, cached=bool(c.cached), owned=c.owned, q=q),
    }


def _trusted(pool: dict[str, Candidate], media_type: str, imdb_answered: bool) -> list[Candidate]:
    """Library matches are by name and year only, so a same-named film (a mockbuster, a remake) can slip in.
    Indexers are queried by IMDb id: once one has answered for a film, drop library hits none of them confirm."""
    if media_type != "movie" or not imdb_answered:
        return list(pool.values())
    return [c for c in pool.values() if c.indexers - {"library"}]


def rank(pool: dict[str, Candidate], q: dict, media_type: str = "tv", imdb_answered: bool = False, title: str = "") -> tuple[list[dict], int]:
    """Rank the whole set first, then filter. Returns (items, hidden_uncached_count)."""
    items, relaxed, hidden = [], [], 0
    if q.get("english_only"):
        # English releases only, unless a title has none at all (a film not made in English): then its
        # original-language releases are better than an empty list.
        eng = {h for h, c in pool.items() if is_english(c.title, c.filename, title=title)}
        if any(pool[h].cached for h in eng):
            pool = {h: c for h, c in pool.items() if h in eng}
    for c in _trusted(pool, media_type, imdb_answered):
        if _NOT_THIS.search(c.title) or _NOT_THIS.search(c.filename):
            continue
        rel = parse(c.title, c.filename)
        if is_blocked(rel, q):
            continue
        if not c.cached and not (q["allow_uncached_add"] and not q["cached_only"]):
            hidden += 1
            continue
        it = to_item(c, q)
        (items if passes(rel, q) else relaxed).append(it)
    items.sort(key=lambda i: i["score"], reverse=True)
    if not items:  # nothing at the requested quality: show the best of what exists
        relaxed.sort(key=lambda i: i["score"], reverse=True)
        items = relaxed[:20]
    # The list is capped, and for big films the top by quality is all 50-65 GB 4K remuxes (TrueHD, Dolby Vision)
    # that most devices must transcode. Keep room for the best light releases that play without TorBox.
    cap = q["max_results"]
    friendly = [i for i in items if i["cached"] and browser_friendly(parse(i["title"], ""))][:20]
    keep = items[: cap - len([f for f in friendly if f not in items[: cap - 20]])] if len(items) > cap else items
    out = keep + [f for f in friendly if f not in keep]
    out.sort(key=lambda i: i["score"], reverse=True)
    return out[:cap], hidden


async def _mark_cached(pool: dict[str, Candidate]) -> None:
    unknown = [c for c in pool.values() if c.cached is None]
    if not unknown:
        return
    # Cap what we ask TorBox about: best-looking 300 by a cheap pre-score (3 parallel calls).
    unknown.sort(key=lambda c: score(parse(c.title, c.filename), seeders=c.seeders, cached=False, owned=False, q=_PRE_Q), reverse=True)
    status = await torbox.cached_status([c.hash for c in unknown[:300]])
    for c in unknown:
        if c.hash in status:
            c.cached = status[c.hash]
    lib_hits = await redis.hmget("lib:hashes", [c.hash for c in unknown])
    for c, tid in zip(unknown, lib_hits):
        if tid:
            c.owned, c.cached = True, True


_PRE_Q = {"prefer_hdr": False, "browser_bias": 50}


async def resolve(meta: dict, season: int | None, episode: int | None, ip: str) -> AsyncIterator[dict]:
    q = await store.quality()
    imdb, mt = meta["imdb_id"], meta["type"]
    ck = f"streams:{CACHE_VERSION}:{imdb}:{season or 0}:{episode or 0}"

    yield {"type": "start", "title": meta["title"]}
    hit = await redis.get(ck)
    if hit:
        data = json.loads(hit)
        yield {"type": "streams", "final": True, "items": data["items"], "hidden": data["hidden"], "from_cache": True}
        yield {"type": "done"}
        return

    pool: dict[str, Candidate] = {}
    for c in await library.match(meta["title"], meta.get("year"), mt, season, episode):
        pool[c.hash] = c
    title = meta["title"]
    if pool and mt != "movie":  # a film's name-only library hits wait for an indexer to confirm them
        items, hidden = rank(pool, q, title=title)
        yield {"type": "streams", "final": False, "items": items, "hidden": hidden}

    indexers = [i for i in await store.indexers() if i.get("enabled")]

    async def run(ix: dict):
        t0 = time.monotonic()
        try:
            res = await ix_mod.fetch(ix, mt, imdb, season, episode)
            return ix["name"], res, None, int((time.monotonic() - t0) * 1000)
        except Exception as e:  # noqa: BLE001
            return ix["name"], [], type(e).__name__, int((time.monotonic() - t0) * 1000)

    tasks = [asyncio.create_task(run(ix)) for ix in indexers]
    failed_all = True
    answered = False  # has any indexer returned results for this IMDb id?
    try:
        for fut in asyncio.as_completed(tasks):
            name, res, err, ms = await fut
            failed_all = failed_all and err is not None
            answered = answered or bool(res)
            for c in res:
                if is_adult(f"{c.title} {c.filename}", title):  # never list adult releases
                    continue
                if c.hash in pool:
                    pool[c.hash].merge(c)
                else:
                    pool[c.hash] = c
            yield {"type": "indexer", "name": name, "count": len(res), "ms": ms, "error": err}
            try:
                await _mark_cached(pool)
            except torbox.TorBoxError as e:
                yield {"type": "error", "code": e.code, "message": e.detail or "TorBox is unavailable"}
                return
            items, hidden = rank(pool, q, mt, answered, title)
            yield {"type": "streams", "final": False, "items": items, "hidden": hidden}
    finally:
        for t in tasks:
            t.cancel()

    items, hidden = rank(pool, q, mt, answered, title)
    if indexers and failed_all and not pool:
        yield {"type": "warning", "message": "All indexers failed to respond"}
    else:
        await redis.setex(ck, 7200 if items else 120, json.dumps({"items": items, "hidden": hidden}))
    yield {"type": "streams", "final": True, "items": items, "hidden": hidden}
    yield {"type": "done"}

    if items:
        film = (meta.get("title") or "", meta.get("year")) if mt == "movie" else None
        asyncio.create_task(_prewarm(items[0], season, episode, ip, film))


async def _prewarm(top: dict, season: int | None, episode: int | None, ip: str, film: tuple[str, int | None] | None = None) -> None:
    """If the best source is already in the library, have its direct link ready before Play."""
    try:
        item = await library.item_by_hash(top["hash"])
        if not item:
            return
        f = pick_file(item["files"], season, episode, *(film or (None, None)))
        if not f:
            return
        ck = f"play:{top['hash']}:{f['id']}:{ip}"
        if await redis.exists(ck):
            return
        url = await torbox.request_dl_raw(item["id"], f["id"], ip or None)
        await redis.setex(ck, 480, url)
    except Exception as e:  # noqa: BLE001
        log.debug("prewarm skipped: %s", e)
