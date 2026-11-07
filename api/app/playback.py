"""Turn (hash, season, episode) into something a browser can play."""

import asyncio
import json
import mimetypes
from urllib.parse import urlsplit

from fastapi import HTTPException

from .adult import is_adult
from . import library, security, settings_store as store, torbox
from .rds import redis
from .release import parse, pick_file


def _err(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status, {"code": code, "message": message})


async def locate(info_hash: str, season: int | None, episode: int | None, film: tuple[str, int | None] | None = None) -> tuple[dict, dict]:
    """Return (library item, chosen file). Adds the torrent to the account only if needed."""
    item = await library.item_by_hash(info_hash)
    if not item:
        q = await store.quality()
        cached = (await torbox.cached_status([info_hash])).get(info_hash.lower(), False)
        if not cached and not (q["allow_uncached_add"] and not q["cached_only"]):
            raise _err(409, "NOT_CACHED", "This source isn't cached on TorBox. Pick another one.")
        created = await torbox.create_torrent(info_hash)
        tid = created.get("torrent_id")
        if not tid:
            raise _err(409, "QUEUED", "TorBox queued this download. Try again in a few minutes.")
        full = None
        for _ in range(4):  # cached torrents appear almost instantly
            full = await torbox.mylist_one(int(tid))
            if full and full.get("files"):
                break
            await asyncio.sleep(0.7)
        item = await library.put_item(full or {})
        if not item:
            raise _err(409, "DOWNLOADING", "TorBox is still downloading this one. Try again shortly.")
    if is_adult(item.get("name") or "", (film or ("", None))[0]):
        raise _err(404, "NOT_THIS_FILM", "This release isn't the film. Pick another source.")
    f = pick_file(item["files"], season, episode, *(film or (None, None)))
    if not f:
        what = f"S{season:02d}E{episode:02d}" if season is not None and episode is not None else "a video file"
        raise _err(404, "FILE_NOT_FOUND", f"Couldn't find {what} in this release. Try another source.")
    return item, f


def _mime(name: str) -> str:
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    # Chromium plays H.264/AAC in Matroska when labelled as mp4; labelling it mkv makes players refuse it.
    return {"mkv": "video/mp4", "mp4": "video/mp4", "m4v": "video/mp4", "mov": "video/mp4", "webm": "video/webm"}.get(
        ext, mimetypes.guess_type(name)[0] or "video/mp4"
    )


def _short(name: str) -> str:
    return name.rsplit("/", 1)[-1]


async def play(
    info_hash: str,
    season: int | None,
    episode: int | None,
    mode: str,
    ip: str,
    audio_index: int | None = None,
    subtitle_index: int | None = None,
    link_id: int = 0,
    film: tuple[str, int | None] | None = None,
) -> dict:
    item, f = await locate(info_hash, season, episode, film)
    hints = parse(_short(f["name"]), item["name"]).to_dict()
    base = {"file": {"name": _short(f["name"]), "size": f["size"]}, "hints": hints, "mode": mode}

    if mode == "direct":
        # TorBox's CDN links can embed the account key. Such a link never reaches a browser: the file is
        # served through this server instead (Range supported), which also removes any CORS problem.
        raw = await redis.get(f"dlraw:{item['id']}:{f['id']}")
        if not raw:
            raw = await torbox.request_dl_raw(item["id"], f["id"], None)
            await redis.setex(f"dlraw:{item['id']}:{f['id']}", 480, raw)
        proxy = f"/api/media/{security.sign_media(item['id'], f['id'], link_id)}"
        if await torbox.embeds_key(raw):
            return {**base, "url": proxy, "proxy": proxy, "mime": _mime(f["name"]), "proxied": True}
        ck = f"play:{info_hash}:{f['id']}:{ip}"
        url = await redis.get(ck)
        if not url:
            url = await torbox.request_dl(item["id"], f["id"], ip or None)
            await redis.setex(ck, 480, url)
        return {**base, "url": url, "proxy": proxy, "mime": _mime(f["name"])}

    ck = f"hls:{info_hash}:{f['id']}:{audio_index}:{subtitle_index}"
    raw = await redis.get(ck)
    if raw:
        s = json.loads(raw)
    else:
        s = torbox.normalize_stream(await torbox.create_stream(item["id"], f["id"], audio_index, subtitle_index))
        if not s["hls_url"]:
            raise _err(502, "NO_HLS", "TorBox couldn't prepare a transcoded stream for this file.")
        await redis.setex(ck, 1200, json.dumps(s))
    url = s["hls_url"]
    if await torbox.embeds_key(url):
        # Same rule as direct play: a URL carrying the account key never reaches a browser. Serve the playlist
        # and its segments through this server under an opaque id instead.
        pid = security.new_token()[:24]
        await redis.setex(f"hlsproxy:{pid}", 6 * 3600, json.dumps({"url": url, "link": link_id}))
        url = f"/api/hls/{pid}/{_short(urlsplit(url).path) or 'index.m3u8'}"
    return {
        **base,
        "url": url,
        "mime": "application/x-mpegurl",
        "audios": s["audios"],
        "subtitles": s["subtitles"],
        "needs_transcoding": s["needs_transcoding"],
    }
