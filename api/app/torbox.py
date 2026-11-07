"""The only module that talks to TorBox.

Every call: key from settings, global per-minute budget, optional hourly budget for adds,
{success, error, detail, data} envelope parsed into typed errors.
"""

import asyncio
import json
import logging
from typing import Any

from . import limiter, settings_store as store
from .config import cfg
from .http import client
from .rds import redis

log = logging.getLogger("marquee.torbox")


class TorBoxError(Exception):
    def __init__(self, code: str, detail: str = "", status: int | None = None):
        super().__init__(f"{code}: {detail}")
        self.code, self.detail, self.status = code, detail, status


class TorBoxAuthError(TorBoxError):
    pass


class TorBoxRateLimited(TorBoxError):
    pass


async def _call(
    method: str,
    path: str,
    *,
    params: dict | None = None,
    json_body: Any = None,
    files: dict | None = None,
    add: bool = False,
    key: str | None = None,
) -> Any:
    key = key or await store.torbox_key()
    if not key:
        raise TorBoxAuthError("NO_KEY", "No TorBox API key is configured")
    try:
        await limiter.acquire(redis, "tb:min", cfg.limit_per_min, 60_000, max_wait_ms=4000)
        if add:
            await limiter.acquire(redis, "tb:add", cfg.limit_adds_per_hour, 3_600_000, max_wait_ms=0)
    except limiter.RateLimited as e:
        raise TorBoxRateLimited("LOCAL_BUDGET", "TorBox request budget used up, try again shortly") from e

    r = await client().request(
        method,
        cfg.torbox_base_url + path,
        params=params,
        json=json_body,
        files=files,
        headers={"Authorization": f"Bearer {key}"},
    )
    if r.status_code == 429:
        raise TorBoxRateLimited("TORBOX_429", "TorBox is rate limiting this account")
    try:
        body = r.json()
    except Exception:
        raise TorBoxError("BAD_RESPONSE", f"HTTP {r.status_code} with a non-JSON body", r.status_code)
    if r.status_code in (401, 403):
        raise TorBoxAuthError(str(body.get("error") or "AUTH"), str(body.get("detail") or "TorBox rejected the key"), r.status_code)
    if isinstance(body, dict) and body.get("success") is False:
        raise TorBoxError(str(body.get("error") or "ERROR"), str(body.get("detail") or ""), r.status_code)
    if r.status_code >= 400:
        raise TorBoxError("HTTP_ERROR", f"HTTP {r.status_code}", r.status_code)
    return body.get("data") if isinstance(body, dict) and "data" in body else body


# --- account -----------------------------------------------------------------


async def user_me(key: str | None = None) -> dict:
    return await _call("GET", "/user/me", key=key)


async def user_me_cached() -> dict:
    raw = await redis.get("tb:me")
    if raw:
        return json.loads(raw)
    me = await user_me()
    await redis.setex("tb:me", 60, json.dumps(me))
    return me


# --- cache check ---------------------------------------------------------------


def _present(data: Any) -> set[str]:
    """checkcached answers with presence = cached. Accept a dict keyed by hash or a list."""
    out: set[str] = set()
    if isinstance(data, dict):
        for k, v in data.items():
            if v not in (None, False):
                out.add(k.lower())
    elif isinstance(data, list):
        for it in data:
            if isinstance(it, str):
                out.add(it.lower())
            elif isinstance(it, dict) and it.get("hash"):
                out.add(str(it["hash"]).lower())
    return out


async def cached_status(hashes: list[str]) -> dict[str, bool]:
    """hash -> cached?  Shared across every viewer through Redis; batches of 100."""
    hashes = list(dict.fromkeys(h.lower() for h in hashes))
    if not hashes:
        return {}
    known = await redis.mget([f"cached:{h}" for h in hashes])
    result: dict[str, bool] = {}
    todo: list[str] = []
    for h, v in zip(hashes, known):
        if v is None:
            todo.append(h)
        else:
            result[h] = v == "1"

    sem = asyncio.Semaphore(3)

    async def batch(chunk: list[str]) -> None:
        async with sem:
            data = await _call("POST", "/torrents/checkcached", params={"format": "list"}, json_body={"hashes": chunk})
        present = _present(data)
        pipe = redis.pipeline()
        for h in chunk:
            hit = h in present
            result[h] = hit
            pipe.setex(f"cached:{h}", 6 * 3600 if hit else 20 * 60, "1" if hit else "0")
        await pipe.execute()

    chunks = [todo[i : i + 100] for i in range(0, len(todo), 100)]
    outcomes = await asyncio.gather(*(batch(c) for c in chunks), return_exceptions=True)
    for o in outcomes:
        if isinstance(o, TorBoxAuthError):
            raise o
        if isinstance(o, Exception):
            log.warning("checkcached batch failed: %s", o)
    return result


# --- library -------------------------------------------------------------------


async def mylist_page(offset: int, limit: int = 500) -> list[dict]:
    data = await _call("GET", "/torrents/mylist", params={"offset": offset, "limit": limit, "bypass_cache": "true"})
    return data if isinstance(data, list) else ([data] if data else [])


async def mylist_all() -> list[dict]:
    """Fully paginated. Never put this on a request path: it is for the background sync."""
    out: list[dict] = []
    offset, limit = 0, 500
    while True:
        page = await mylist_page(offset, limit)
        out.extend(page)
        if len(page) < limit:
            return out
        offset += limit


async def mylist_one(torrent_id: int) -> dict | None:
    data = await _call("GET", "/torrents/mylist", params={"id": torrent_id, "bypass_cache": "true"})
    if isinstance(data, list):
        return data[0] if data else None
    return data or None


async def create_torrent(info_hash: str) -> dict:
    """Add by magnet. Must be multipart/form-data; JSON is rejected."""
    magnet = f"magnet:?xt=urn:btih:{info_hash}"
    form = {"magnet": (None, magnet), "seed": (None, "1"), "allow_zip": (None, "false")}
    data = await _call("POST", "/torrents/createtorrent", files=form, add=True)
    return data if isinstance(data, dict) else {}


# --- links & streams -----------------------------------------------------------


async def request_dl_raw(torrent_id: int, file_id: int, user_ip: str | None) -> str:
    """The CDN link exactly as TorBox returns it. It may embed the account key, so it must stay on the server."""
    key = await store.torbox_key()
    params: dict[str, Any] = {
        "token": key,
        "torrent_id": torrent_id,
        "file_id": file_id,
        "zip_link": "false",
        "redirect": "false",
    }
    if user_ip:
        params["user_ip"] = user_ip
    url = await _call("GET", "/torrents/requestdl", params=params)
    if not isinstance(url, str) or not url.startswith("http"):
        raise TorBoxError("BAD_LINK", "TorBox did not return a download link")
    return url


async def embeds_key(url: str) -> bool:
    key = await store.torbox_key()
    return bool(key) and key in url


async def request_dl(torrent_id: int, file_id: int, user_ip: str | None) -> str:
    """A link that is safe to give to a browser (never contains the account key)."""
    url = await request_dl_raw(torrent_id, file_id, user_ip)
    if await embeds_key(url):
        raise TorBoxError("KEY_IN_URL", "Refusing to return a link that embeds the API key")
    return url


async def create_stream(torrent_id: int, file_id: int, audio_index: int | None = None, subtitle_index: int | None = None) -> dict:
    params: dict[str, Any] = {"id": torrent_id, "file_id": file_id, "type": "torrent"}
    if audio_index is not None:
        params["chosen_audio_index"] = audio_index
    if subtitle_index is not None:
        params["chosen_subtitle_index"] = subtitle_index
    data = await _call("GET", "/stream/createstream", params=params)
    data = data if isinstance(data, dict) else {}
    if not data.get("hls_url") and data.get("presigned_token") and data.get("token"):
        more = await _call(
            "GET",
            "/stream/getstreamdata",
            params={"presigned_token": data["presigned_token"], "token": data["token"]},
        )
        if isinstance(more, dict):
            data = {**data, **more}
    return data


def normalize_stream(data: dict) -> dict:
    meta = data.get("metadata") or {}
    return {
        "hls_url": data.get("hls_url"),
        "needs_transcoding": data.get("needs_transcoding"),
        "audios": meta.get("audios") or [],
        "subtitles": meta.get("subtitles") or [],
        "video": meta.get("video") or {},
    }
