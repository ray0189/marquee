import json
from typing import Any

import httpx
from fastapi import HTTPException

from . import settings_store as store
from .config import cfg
from .http import client
from .rds import redis


async def req(path: str, params: dict | None = None, ttl: int = 3600) -> Any:
    key = await store.tmdb_key()
    if not key:
        raise HTTPException(503, {"code": "NO_TMDB", "message": "TMDB key is not configured (admin → Keys)"})
    params = {k: v for k, v in (params or {}).items() if v is not None}
    ck = f"tmdb:{path}:{json.dumps(params, sort_keys=True)}"
    if ttl > 0:
        cached = await redis.get(ck)
        if cached:
            return json.loads(cached)
    headers = {}
    send = dict(params)
    if key.startswith("eyJ"):  # v4 read token
        headers["Authorization"] = f"Bearer {key}"
    else:
        send["api_key"] = key
    try:
        r = await client().get(cfg.tmdb_base_url + path, params=send, headers=headers)
    except httpx.HTTPError:
        raise HTTPException(503, {"code": "TMDB_DOWN", "message": "Can't reach TMDB right now. Try again in a moment."})
    if r.status_code == 404:
        raise HTTPException(404, {"code": "NOT_FOUND", "message": "Not found"})
    if r.status_code in (401, 403):
        raise HTTPException(503, {"code": "TMDB_KEY", "message": "TMDB rejected the key"})
    if r.status_code >= 400:
        busy = r.status_code == 429
        raise HTTPException(503, {"code": "TMDB_BUSY" if busy else "TMDB_ERROR", "message": "TMDB is busy. Try again in a moment." if busy else f"TMDB answered {r.status_code}. Try again in a moment."})
    data = r.json()
    if ttl > 0:
        await redis.setex(ck, ttl, json.dumps(data))
    return data


def _year(date: str | None) -> int | None:
    return int(date[:4]) if date and date[:4].isdigit() else None


def card(it: dict, media_type: str | None = None) -> dict | None:
    mt = it.get("media_type") or media_type
    if mt not in ("movie", "tv") or "id" not in it or it.get("adult"):
        return None
    return {
        "id": it["id"],
        "type": mt,
        "title": it.get("title") or it.get("name") or "",
        "year": _year(it.get("release_date") or it.get("first_air_date")),
        "poster": it.get("poster_path"),
        "backdrop": it.get("backdrop_path"),
        "overview": it.get("overview") or "",
        "rating": round(it.get("vote_average") or 0, 1),
        "popularity": it.get("popularity") or 0,
    }


def cards(results: list[dict], media_type: str | None = None) -> list[dict]:
    return [c for it in results if (c := card(it, media_type))]


async def meta(media_type: str, tmdb_id: int) -> dict:
    d = await req(
        f"/{media_type}/{tmdb_id}",
        {"append_to_response": "external_ids,credits,recommendations,content_ratings,release_dates"},
        ttl=86400,
    )
    if d.get("adult"):
        raise HTTPException(404, {"code": "NOT_FOUND", "message": "Not available."})
    ext = d.get("external_ids") or {}
    cert = ""
    if media_type == "movie":
        for c in (d.get("release_dates") or {}).get("results", []):
            if c.get("iso_3166_1") in ("GB", "US"):
                for rd in c.get("release_dates", []):
                    if rd.get("certification"):
                        cert = rd["certification"]
                        break
            if cert:
                break
    else:
        for c in (d.get("content_ratings") or {}).get("results", []):
            if c.get("iso_3166_1") in ("GB", "US") and c.get("rating"):
                cert = c["rating"]
                break
    base = card(d, media_type) or {}
    runtime = d.get("runtime") or (d.get("episode_run_time") or [None])[0]
    return {
        **base,
        "imdb_id": d.get("imdb_id") or ext.get("imdb_id"),
        "tagline": d.get("tagline") or "",
        "runtime": runtime,
        "genres": [g["name"] for g in d.get("genres", [])],
        "certification": cert,
        "status": d.get("status"),
        "cast": [
            {"name": p["name"], "character": p.get("character", ""), "photo": p.get("profile_path")}
            for p in (d.get("credits") or {}).get("cast", [])[:14]
        ],
        "seasons": [
            {
                "number": s["season_number"],
                "name": s.get("name"),
                "episodes": s.get("episode_count"),
                "poster": s.get("poster_path"),
                "air_date": s.get("air_date"),
            }
            for s in d.get("seasons", [])
            if s.get("season_number", 0) > 0
        ],
        "similar": cards((d.get("recommendations") or {}).get("results", []), media_type)[:16],
        "last_aired": _ep_ref(d.get("last_episode_to_air")),
    }


def _ep_ref(e: dict | None) -> dict | None:
    if not e or e.get("season_number") is None or e.get("episode_number") is None:
        return None
    return {"season": e["season_number"], "episode": e["episode_number"]}


def next_episode(m: dict, season: int, episode: int) -> dict | None:
    """The episode after (season, episode) that has already aired, or None."""
    seasons = {s["number"]: s.get("episodes") or 0 for s in m.get("seasons", [])}
    if episode < seasons.get(season, 0):
        nxt = {"season": season, "episode": episode + 1}
    elif season + 1 in seasons and seasons[season + 1] > 0:
        nxt = {"season": season + 1, "episode": 1}
    else:
        return None
    last = m.get("last_aired")
    if last and (nxt["season"], nxt["episode"]) > (last["season"], last["episode"]):
        return None
    return nxt


async def season(tmdb_id: int, number: int) -> dict:
    d = await req(f"/tv/{tmdb_id}/season/{number}", ttl=86400)
    return {
        "number": number,
        "name": d.get("name"),
        "episodes": [
            {
                "number": e["episode_number"],
                "name": e.get("name"),
                "overview": e.get("overview") or "",
                "still": e.get("still_path"),
                "air_date": e.get("air_date"),
                "runtime": e.get("runtime"),
                "rating": round(e.get("vote_average") or 0, 1),
            }
            for e in d.get("episodes", [])
        ],
    }
