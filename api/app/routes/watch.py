import asyncio
import json
import re
import logging
import time
from typing import Literal
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import devices, limiter, playback, resolver, search, subtitles, tmdb, torbox
from ..config import cfg
from ..db import get_db
from ..deps import LinkInfo, _link_state, require_link
from ..models import History, Link, iso, utcnow
from ..http import client
from ..rds import redis
from ..security import COOKIE, MAX_AGE, URL_TOKEN_AGE, client_ip, hash_token, is_https, read_media, read_session, sign_session, sign_url_token

log = logging.getLogger("marquee.watch")
router = APIRouter()
MediaType = Literal["movie", "tv"]


_tasks: set[asyncio.Task] = set()


def _bg(coro) -> None:
    """Fire-and-forget that keeps a reference, so the task isn't garbage-collected mid-run."""
    t = asyncio.create_task(coro)
    _tasks.add(t)
    t.add_done_callback(_tasks.discard)


# --- access ---------------------------------------------------------------------


class JoinReq(BaseModel):
    token: str = Field(min_length=10, max_length=200)


@router.post("/join")
async def join(body: JoinReq, request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    try:
        await limiter.acquire(redis, f"join:{client_ip(request)}", 10, 60_000)
    except limiter.RateLimited:
        raise HTTPException(429, {"code": "SLOW_DOWN", "message": "Too many attempts"})
    link = (await db.execute(select(Link).where(Link.token_hash == hash_token(body.token.strip())))).scalar_one_or_none()
    if not link or link.revoked_at:
        raise HTTPException(403, {"code": "BAD_LINK", "message": "This invite link isn't valid."})
    # Re-opening the link on a device that's already in costs nothing; a new device needs a free slot.
    old = request.cookies.get(COOKIE) or request.headers.get("x-mq-session")
    if old and read_session(old) == link.id:
        try:
            await devices.check(link.id, old, request)
            return {"ok": True, "label": link.label, "session": old}
        except HTTPException:
            pass
    if await devices.active_count(db, link.id) >= cfg.max_devices:
        raise devices.full_error()
    token = sign_session(link.id)
    await devices.register(db, link.id, token, request)
    await db.commit()
    response.set_cookie(COOKIE, token, max_age=MAX_AGE, httponly=True, samesite="lax", secure=is_https(request), path="/")
    return {"ok": True, "label": link.label, "session": token}


@router.get("/me")
async def me(link: LinkInfo = Depends(require_link)):
    return {"label": link.label}


@router.get("/url-token")
async def url_token(link: LinkInfo = Depends(require_link)):
    """A short-lived token for URLs the browser fetches itself; the page refreshes it well before it expires."""
    return {"token": sign_url_token(link.id), "max_age": URL_TOKEN_AGE}


# --- browse ---------------------------------------------------------------------


REGION = "GB"
TODAY = lambda: time.strftime("%Y-%m-%d")  # noqa: E731


def _spec(title, path, mt=None, more=None, **params):
    return {"title": title, "path": path, "mt": mt, "more": more, "params": {"watch_region": REGION, **params}}


def _home_specs() -> list[dict]:
    d = TODAY()
    return [
        _spec("Trending today", "/trending/all/day"),
        _spec("Popular films", "/movie/popular", "movie", "/browse/movie?sort=popular"),
        _spec("Popular series", "/tv/popular", "tv", "/browse/tv?sort=popular"),
        _spec("Top 10 this week", "/trending/all/week"),
        _spec("In cinemas now", "/movie/now_playing", "movie"),
        _spec("On Netflix", "/discover/tv", "tv", "/browse/tv?provider=8", with_watch_providers=8, sort_by="popularity.desc", **{"vote_count.gte": 50}),
        _spec("On Prime Video", "/discover/movie", "movie", "/browse/movie?provider=9", with_watch_providers=9, sort_by="popularity.desc", **{"vote_count.gte": 50}),
        _spec("On Disney+", "/discover/movie", "movie", "/browse/movie?provider=337", with_watch_providers=337, sort_by="popularity.desc", **{"vote_count.gte": 50}),
        _spec("On Apple TV+", "/discover/tv", "tv", "/browse/tv?provider=350", with_watch_providers=350, sort_by="popularity.desc"),
        _spec("Action & adventure", "/discover/movie", "movie", "/browse/movie?genre=28", with_genres=28, sort_by="popularity.desc", **{"vote_count.gte": 200}),
        _spec("Sci-fi & fantasy series", "/discover/tv", "tv", "/browse/tv?genre=10765", with_genres=10765, sort_by="popularity.desc", **{"vote_count.gte": 100}),
        _spec("Crime & thriller series", "/discover/tv", "tv", "/browse/tv?genre=80", with_genres=80, sort_by="popularity.desc", **{"vote_count.gte": 100}),
        _spec("Comedy", "/discover/movie", "movie", "/browse/movie?genre=35", with_genres=35, sort_by="popularity.desc", **{"vote_count.gte": 200}),
        _spec("Horror", "/discover/movie", "movie", "/browse/movie?genre=27", with_genres=27, sort_by="popularity.desc", **{"vote_count.gte": 200}),
        _spec("Anime", "/discover/tv", "tv", "/browse/tv?genre=16&lang=ja", with_genres=16, with_original_language="ja", sort_by="popularity.desc", **{"vote_count.gte": 50}),
        _spec("Animation for everyone", "/discover/movie", "movie", "/browse/movie?genre=16", with_genres=16, sort_by="popularity.desc", **{"vote_count.gte": 200}),
        _spec("Documentaries", "/discover/movie", "movie", "/browse/movie?genre=99", with_genres=99, sort_by="popularity.desc", **{"vote_count.gte": 50}),
        _spec("Hidden gems", "/discover/movie", "movie", "/browse/movie?sort=rated", sort_by="vote_average.desc", **{"vote_count.gte": 400, "vote_count.lte": 3500, "vote_average.gte": 7.4}),
        _spec("Critically acclaimed films", "/movie/top_rated", "movie", "/browse/movie?sort=rated"),
        _spec("Top rated series", "/tv/top_rated", "tv", "/browse/tv?sort=rated"),
        _spec("Airing now", "/tv/on_the_air", "tv"),
        _spec("Coming soon", "/discover/movie", "movie", None, sort_by="popularity.desc", **{"primary_release_date.gte": d, "with_release_type": "2|3"}),
    ]


@router.get("/home")
async def home(link: LinkInfo = Depends(require_link)):
    async def row(s):
        data = await tmdb.req(s["path"], s["params"], ttl=3600)
        return {"title": s["title"], "more": s["more"], "items": tmdb.cards(data.get("results", []), s["mt"])[:20]}

    done = await asyncio.gather(*(row(s) for s in _home_specs()), return_exceptions=True)
    # TMDB's lists overlap heavily (the same blockbusters top "Popular", "Trending", "Action"...), so each title
    # appears once, in the first row that has it; rows left too thin are dropped.
    rows, seen = [], set()
    for r in done:
        if not isinstance(r, dict):
            continue
        fresh = [i for i in r["items"] if (i["type"], i["id"]) not in seen]
        if not fresh or len(fresh) < min(8, len(r["items"])):  # thinned out by repeats (a naturally short row is fine)
            continue
        seen.update((i["type"], i["id"]) for i in fresh)
        rows.append({**r, "items": fresh})
    if not rows:
        first_err = next((r for r in done if isinstance(r, Exception)), None)
        if isinstance(first_err, HTTPException):
            raise first_err
    hero = [i for i in (rows[0]["items"] if rows else []) if i["backdrop"] and i["overview"]][:7]
    return {"hero": hero, "rows": rows}


@router.get("/search")
async def do_search(q: str = "", type: MediaType | None = None, link: LinkInfo = Depends(require_link)):
    q = q.strip()[:200]  # longer than any real title; very long input was passed straight on to TMDB
    if not q:
        return {"items": []}
    items = await search.query(q, 24, type)
    if sum(1 for i in items if search.match_tier(q, i) < 3) < 3:  # too few real title matches: ask TMDB too
        data = await tmdb.req("/search/multi" if not type else f"/search/{type}", {"query": q, "include_adult": "false"}, ttl=600)
        extra = tmdb.cards(data.get("results", []), type)
        seen = {(i["type"], i["id"]) for i in items}
        fresh = [c for c in extra if (c["type"], c["id"]) not in seen]
        items = search.rerank(q, items + fresh, 24)
        _bg(search.upsert(fresh))
    return {"items": items[:24]}


@router.get("/genres/{media_type}")
async def genres(media_type: MediaType, link: LinkInfo = Depends(require_link)):
    return (await tmdb.req(f"/genre/{media_type}/list", ttl=86400)).get("genres", [])


@router.get("/browse")
async def browse(
    type: MediaType,
    genre: int | None = None,
    sort: Literal["popular", "rated", "new", "trending"] = "popular",
    year: int | None = None,
    decade: int | None = None,
    rating: float | None = None,
    provider: int | None = None,
    lang: str | None = None,
    page: int = 1,
    link: LinkInfo = Depends(require_link),
):
    """Filtered discovery. Every filter is optional and they combine; sensible vote floors keep junk out."""
    page = max(1, min(page, 500))
    if sort == "trending" and not any((genre, year, decade, rating, provider, lang)):
        data = await tmdb.req(f"/trending/{type}/week", {"page": page}, ttl=1800)
        return {"items": tmdb.cards(data.get("results", []), type), "page": page, "total_pages": min(data.get("total_pages", 1), 500)}

    date_field = "primary_release_date" if type == "movie" else "first_air_date"
    sort_by = {"popular": "popularity.desc", "trending": "popularity.desc", "rated": "vote_average.desc", "new": f"{date_field}.desc"}[sort]
    floor = {"rated": 500 if type == "movie" else 250, "new": 25, "popular": 30, "trending": 30}[sort]
    if rating:
        floor = max(floor, 100)
    gte = lte = None
    if year:
        gte, lte = f"{year}-01-01", f"{year}-12-31"
    elif decade:
        gte, lte = f"{decade}-01-01", f"{decade + 9}-12-31"
    if sort == "new":
        lte = min(lte, TODAY()) if lte else TODAY()
    params = {
        "sort_by": sort_by,
        "with_genres": genre,
        "with_watch_providers": provider,
        "watch_region": REGION if provider else None,
        "with_original_language": lang,
        "vote_average.gte": rating,
        "page": page,
        "include_adult": "false",
        "vote_count.gte": floor,
        f"{date_field}.gte": gte,
        f"{date_field}.lte": lte,
    }
    data = await tmdb.req(f"/discover/{type}", params, ttl=1800)
    return {"items": tmdb.cards(data.get("results", []), type), "page": data.get("page", 1), "total_pages": min(data.get("total_pages", 1), 500)}


@router.get("/meta/{media_type}/{tmdb_id}")
async def meta(media_type: MediaType, tmdb_id: int, link: LinkInfo = Depends(require_link)):
    return await tmdb.meta(media_type, tmdb_id)


@router.get("/meta/tv/{tmdb_id}/season/{number}")
async def season(tmdb_id: int, number: int, link: LinkInfo = Depends(require_link)):
    return await tmdb.season(tmdb_id, number)


# --- sources ---------------------------------------------------------------------


@router.get("/streams/{media_type}/{tmdb_id}")
async def streams(
    media_type: MediaType,
    tmdb_id: int,
    request: Request,
    season: int | None = None,
    episode: int | None = None,
    link: LinkInfo = Depends(require_link),
):
    if media_type == "tv" and (season is None or episode is None):
        raise HTTPException(422, {"code": "EPISODE", "message": "season and episode are required"})
    m = await tmdb.meta(media_type, tmdb_id)
    if not m.get("imdb_id"):
        raise HTTPException(404, {"code": "NO_IMDB", "message": "No IMDb id for this title, can't look up sources."})
    ip = client_ip(request)

    async def gen():
        try:
            async for ev in resolver.resolve(m, season, episode, ip):
                yield f"data: {json.dumps(ev)}\n\n"
        except Exception as e:  # noqa: BLE001
            log.exception("resolver failed")
            yield f"data: {json.dumps({'type': 'error', 'code': 'RESOLVER', 'message': str(e)[:200]})}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/subtitles/{media_type}/{tmdb_id}")
async def subs(media_type: MediaType, tmdb_id: int, season: int | None = None, episode: int | None = None, file: str = "", link: LinkInfo = Depends(require_link)):
    m = await tmdb.meta(media_type, tmdb_id)
    if not m.get("imdb_id"):
        return []
    file = file[-200:]
    key = f"subs2:{m['imdb_id']}:{season}:{episode}:{hash_token(file)[:16]}"
    cached = await redis.get(key)
    if cached:
        return json.loads(cached)
    out = await subtitles.list_for(m["imdb_id"], media_type, season, episode, file)
    await redis.setex(key, 6 * 3600 if out else 300, json.dumps(out))
    return out


@router.get("/subs/vtt")
async def vtt(u: str, shift: float = 0, link: LinkInfo = Depends(require_link)):
    text = subtitles.shift_vtt(await subtitles.fetch_vtt(u), max(-120.0, min(120.0, shift)))
    return Response(text, media_type="text/vtt; charset=utf-8", headers={"Cache-Control": "private, max-age=86400"})


# --- playback ---------------------------------------------------------------------


class PlayReq(BaseModel):
    media_type: MediaType
    tmdb_id: int
    hash: str = Field(pattern=r"^[A-Fa-f0-9]{40}$")
    season: int | None = None
    episode: int | None = None
    mode: Literal["direct", "hls"] = "direct"
    audio_index: int | None = None
    subtitle_index: int | None = None


@router.post("/play")
async def play(body: PlayReq, request: Request, link: LinkInfo = Depends(require_link), db: AsyncSession = Depends(get_db)):
    if body.media_type == "tv" and (body.season is None or body.episode is None):
        raise HTTPException(422, {"code": "EPISODE", "message": "season and episode are required"})
    t0 = time.monotonic()
    film = None
    if body.media_type == "movie":  # lets a collection pack serve the right film
        m = await tmdb.meta("movie", body.tmdb_id)
        film = (m.get("title") or "", m.get("year"))
    t1 = time.monotonic()
    res = await playback.play(body.hash.lower(), body.season, body.episode, body.mode, client_ip(request), body.audio_index, body.subtitle_index, link.id, film)
    if (took := time.monotonic() - t0) > 1.5:
        log.warning("slow play link=%s hash=%s mode=%s total=%.1fs tmdb=%.1fs", link.id, body.hash[:12], body.mode, took, t1 - t0)
    now = time.time()
    await redis.zadd("plays", {f"{link.id}:{now}": now})
    await redis.zremrangebyscore("plays", 0, now - 3600)
    await db.execute(update(Link).where(Link.id == link.id).values(play_count=Link.play_count + 1))
    await db.commit()
    return res


# --- history ----------------------------------------------------------------------


FINISHED = 0.94  # watched this much of something = done


class HistoryReq(BaseModel):
    media_type: MediaType
    tmdb_id: int
    season: int | None = None
    episode: int | None = None
    position: float = Field(ge=0)
    duration: float = Field(ge=0)
    title: str = Field(max_length=200)
    poster: str | None = Field(None, max_length=120)
    backdrop: str | None = Field(None, max_length=120)


def _hist(h: History) -> dict:
    return {
        "type": h.media_type, "id": h.tmdb_id, "season": h.season, "episode": h.episode,
        "position": h.position, "duration": h.duration, "title": h.title,
        "poster": h.poster, "backdrop": h.backdrop, "updated_at": iso(h.updated_at),
    }


@router.put("/history")
async def save_history(body: HistoryReq, link: LinkInfo = Depends(require_link), db: AsyncSession = Depends(get_db)):
    row = (
        await db.execute(select(History).where(History.link_id == link.id, History.media_type == body.media_type, History.tmdb_id == body.tmdb_id))
    ).scalar_one_or_none()
    if row is None:
        row = History(link_id=link.id, media_type=body.media_type, tmdb_id=body.tmdb_id)
        db.add(row)
    season, episode, position, duration = body.season, body.episode, body.position, body.duration
    if body.media_type == "tv" and season is not None and episode is not None and duration > 0 and position / duration >= FINISHED:
        # Finished an episode: keep the show in Continue watching, pointing at the next one that has aired.
        try:
            nxt = tmdb.next_episode(await tmdb.meta("tv", body.tmdb_id), season, episode)
        except HTTPException:
            nxt = None
        if nxt:
            season, episode, position, duration = nxt["season"], nxt["episode"], 0.0, 0.0
    row.season, row.episode = season, episode
    row.position, row.duration = position, duration
    row.title, row.poster, row.backdrop = body.title, body.poster, body.backdrop
    row.updated_at = utcnow()
    try:
        await db.commit()
    except IntegrityError:
        # Two saves raced to create the row (e.g. two tabs); the other one won, so update it instead.
        await db.rollback()
        await db.execute(
            update(History)
            .where(History.link_id == link.id, History.media_type == body.media_type, History.tmdb_id == body.tmdb_id)
            .values(season=season, episode=episode, position=position, duration=duration,
                    title=body.title, poster=body.poster, backdrop=body.backdrop, updated_at=utcnow())
        )
        await db.commit()
    return {"ok": True}


@router.get("/history")
async def continue_watching(link: LinkInfo = Depends(require_link), db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(History).where(History.link_id == link.id).order_by(History.updated_at.desc()).limit(40))).scalars().all()
    def show(h: History) -> bool:
        if h.media_type == "tv" and h.duration == 0 and h.position == 0 and h.episode:
            return True  # "up next": the previous episode was finished
        return h.position > 30 and (h.duration <= 0 or h.position / h.duration < FINISHED)

    out = [_hist(h) for h in rows if show(h)]
    return out[:20]


@router.get("/history/{media_type}/{tmdb_id}")
async def title_history(media_type: MediaType, tmdb_id: int, link: LinkInfo = Depends(require_link), db: AsyncSession = Depends(get_db)):
    row = (
        await db.execute(select(History).where(History.link_id == link.id, History.media_type == media_type, History.tmdb_id == tmdb_id))
    ).scalar_one_or_none()
    return _hist(row) if row else None


# --- playback diagnostics -----------------------------------------------------------------


class StallReport(BaseModel):
    mode: str = Field(max_length=12)
    secs: float = Field(ge=0, le=600)
    at: float = Field(ge=0, le=100000)
    ahead: float = Field(ge=-1, le=100000)
    ready: int = Field(ge=0, le=4)
    net: int = Field(ge=0, le=3)
    boost: bool = False
    ctx: str = Field("", max_length=12)
    nudged: int = Field(0, ge=0, le=1000)
    ua: str = Field("", max_length=40)


@router.post("/diag/stall")
async def stall(body: StallReport, link: LinkInfo = Depends(require_link)):
    """A viewer's player froze: one log line to find the cause (nothing is stored)."""
    log.warning("stall link=%s %s", link.id, body.model_dump_json())
    return {"ok": True}


# --- media proxy ---------------------------------------------------------------------------


_SAFE_HLS_PATH = re.compile(r"[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*")


@router.get("/hls/{pid}/{path:path}")
async def hls_proxy(pid: str, path: str, request: Request):
    """Transcoded (HLS) stream whose TorBox URL embeds the account key: relay the playlist and segments.
    Relative entries resolve against this route by themselves; absolute ones on the same host are rewritten."""
    # Only plain file names under the stream's own folder: no "..", leading slash, backslash or full URL, which
    # could otherwise reach other paths on TorBox's servers with this stream's token.
    if not _SAFE_HLS_PATH.fullmatch(path) or ".." in path or path.startswith("/"):
        raise HTTPException(404, {"code": "BAD_MEDIA", "message": "Not found"})
    raw = await redis.get(f"hlsproxy:{pid}")
    if not raw:
        raise HTTPException(404, {"code": "BAD_MEDIA", "message": "That stream link has expired. Press play again."})
    info = json.loads(raw)
    if not (await _link_state(int(info["link"])))["ok"]:
        raise HTTPException(401, {"code": "REVOKED", "message": "This invite link is no longer active."})
    origin = urlsplit(info["url"])
    base_dir = origin.path.rsplit("/", 1)[0] + "/"
    target = f"{origin.scheme}://{origin.netloc}{base_dir}{path}"
    query = request.url.query or origin.query  # segments usually need the playlist's query (it holds the token)
    if query:
        target += "?" + query
    up = await client().get(target, timeout=httpx.Timeout(30.0, read=60.0))
    if up.status_code >= 400:
        raise HTTPException(502, {"code": "UPSTREAM", "message": f"TorBox's stream server answered {up.status_code}."})
    ctype = up.headers.get("content-type", "")
    if path.endswith(".m3u8") or "mpegurl" in ctype.lower():
        host = f"{origin.scheme}://{origin.netloc}"
        lines = []
        for line in up.text.splitlines():
            if line.startswith(host + base_dir):
                line = line[len(host + base_dir):]
            elif line.startswith(host):
                line = None  # outside the playlist's folder: can't be relayed safely
            if line is not None:
                lines.append(line)
        return Response("\n".join(lines) + "\n", media_type="application/vnd.apple.mpegurl", headers={"Cache-Control": "no-store"})
    return Response(up.content, media_type=ctype or "video/mp2t", headers={"Cache-Control": "private, max-age=3600"})


@router.api_route("/media/{sig}", methods=["GET", "HEAD"])
async def media(sig: str, request: Request):
    """Stream a file from TorBox through this server, passing Range requests straight through.

    Used when TorBox's download link embeds the account key (it must never reach a browser) and as the
    same-origin fallback when the CDN refuses cross-origin reads. The signed, expiring handle IS the
    authorisation: it is only ever issued by /play to a valid invite link, so no cookie is needed. That keeps
    it working for native iOS players and any device that drops cookies.
    """
    ids = read_media(sig)
    if not ids:
        raise HTTPException(404, {"code": "BAD_MEDIA", "message": "That stream link has expired. Press play again."})
    tid, fid, lid = ids
    if not (await _link_state(lid))["ok"]:
        raise HTTPException(401, {"code": "REVOKED", "message": "This invite link is no longer active."})
    ck, fk = f"dlraw:{tid}:{fid}", f"dlfinal:{tid}:{fid}"
    # Where TorBox's redirects end up: every seek is a new request, and following the hops each time added a
    # round trip per hop before the first byte.
    url = await redis.get(fk) or await redis.get(ck)
    if not url:
        url = await torbox.request_dl_raw(tid, fid, None)
        await redis.setex(ck, 480, url)
    headers = {"Range": request.headers["range"]} if "range" in request.headers else {}
    c = client()
    timeout = httpx.Timeout(30.0, read=120.0)
    t0 = time.monotonic()
    up = await c.send(c.build_request(request.method, url, headers=headers, timeout=timeout), stream=True)
    for _ in range(4):  # the shared client doesn't follow redirects; CDN hops would reach the browser without a Location
        if up.status_code not in (301, 302, 303, 307, 308) or not up.next_request:
            break
        nxt = up.next_request.url
        await up.aclose()
        up = await c.send(c.build_request(request.method, nxt, headers=headers, timeout=timeout), stream=True)
    if (up.status_code >= 300 and up.status_code != 416):
        await up.aclose()
        await redis.delete(ck, fk)  # the signed link may have expired; the next request fetches a new one
        raise HTTPException(502, {"code": "UPSTREAM", "message": f"TorBox's server answered {up.status_code}."})
    if (took := time.monotonic() - t0) > 1.5:
        log.warning("slow media link=%s first-byte=%.1fs range=%s", lid, took, headers.get("Range", ""))
    if str(up.request.url) != url:
        await redis.setex(fk, 300, str(up.request.url))
    out = {k: v for k, v in up.headers.items() if k.lower() in {"content-length", "content-range", "accept-ranges", "etag", "last-modified"}}
    out.setdefault("Accept-Ranges", "bytes")
    out["Cache-Control"] = "private, max-age=3600"

    async def body():
        try:
            async for chunk in up.aiter_raw(1 << 20):  # 1 MB: 64 KB chunks kept the API CPU-bound on big 4K files
                yield chunk
        finally:
            await up.aclose()

    if request.method == "HEAD":
        await up.aclose()
        return Response(status_code=up.status_code, headers=out, media_type=up.headers.get("content-type", "application/octet-stream"))
    return StreamingResponse(body(), status_code=up.status_code, headers=out, media_type=up.headers.get("content-type", "application/octet-stream"))
