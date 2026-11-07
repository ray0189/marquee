import asyncio
import json
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import devices as devs, library, limiter, search, settings_store as store, torbox
from ..config import cfg
from ..db import get_db
from ..deps import _admin_fail, require_admin
from ..http import client
from ..models import Device, Link, iso
from ..rds import redis
from ..security import check_password, decrypt, encrypt, hash_password, hash_token, new_token

router = APIRouter(dependencies=[Depends(require_admin)])


@router.get("/ping")
async def ping(who: dict = Depends(require_admin)):
    return {"ok": True, **who}


# --- overview ---------------------------------------------------------------------


@router.get("/status")
async def status(db: AsyncSession = Depends(get_db)):
    async def tb() -> dict:
        key = await store.torbox_key()
        if not key:
            return {"configured": False}
        try:
            me = await torbox.user_me_cached()
            return {
                "configured": True, "ok": True, "plan": me.get("plan"), "email": _mask(me.get("email", "")),
                "premium_expires_at": me.get("premium_expires_at"),
                "source": "admin" if await store.get("torbox_key") else "env",
            }
        except torbox.TorBoxError as e:
            return {"configured": True, "ok": False, "error": e.detail or e.code}

    async def indexers() -> list[dict]:
        out = []
        for ix in await store.indexers():
            last = await redis.get(f"ix:last:{ix['name']}")
            out.append({**ix, "down": bool(await redis.exists(f"ix:down:{ix['name']}")), "last": json.loads(last) if last else None})
        return out

    now = time.time()
    t, ixs, lib, docs, used_min, used_hour, plays = await asyncio.gather(
        tb(), indexers(), library.stats(), search.count(),
        limiter.usage(redis, "tb:min", 60_000), limiter.usage(redis, "tb:add", 3_600_000),
        redis.zcount("plays", now - 600, "+inf"),
    )
    total = (await db.execute(select(func.count()).select_from(Link))).scalar_one()
    active = (await db.execute(select(func.count()).select_from(Link).where(Link.revoked_at.is_(None)))).scalar_one()
    return {
        "torbox": t,
        "limits": {"minute": {"used": used_min, "limit": cfg.limit_per_min}, "hour": {"used": used_hour, "limit": cfg.limit_adds_per_hour}},
        "library": lib, "plays_10m": plays, "links": {"active": active, "total": total},
        "indexers": ixs, "tmdb": {"configured": bool(await store.tmdb_key())}, "search": {"documents": docs},
    }


def _mask(email: str) -> str:
    if "@" not in email:
        return ""
    user, dom = email.split("@", 1)
    return user[:2] + "•••@" + dom


@router.post("/library/sync")
async def sync_library():
    try:
        return await library.sync()
    except torbox.TorBoxError as e:
        raise HTTPException(502, {"code": e.code, "message": e.detail or "TorBox error"})


# --- links ------------------------------------------------------------------------


class NewLink(BaseModel):
    label: str = Field(min_length=1, max_length=80)


async def _url(token: str) -> str:
    return f"{((await store.get('watch_url')) or cfg.public_watch_url).rstrip('/')}/j/{token}"


def _device(d: Device) -> dict:
    return {"id": d.id, "user_agent": d.user_agent, "ip": d.ip, "created_at": iso(d.created_at), "last_seen_at": iso(d.last_seen_at)}


async def _link(l: Link, devices: list[Device] | None = None) -> dict:
    url = None
    if l.token_enc and not l.revoked_at:
        try:
            url = await _url(decrypt(l.token_enc))
        except Exception:  # noqa: BLE001  (secret changed since it was stored)
            url = None
    return {
        "id": l.id, "label": l.label, "created_at": iso(l.created_at), "last_seen_at": iso(l.last_seen_at),
        "revoked_at": iso(l.revoked_at), "play_count": l.play_count, "url": url,
        "devices": [_device(d) for d in devices or []], "max_devices": cfg.max_devices,
    }


@router.get("/links")
async def links(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(Link).order_by(Link.created_at.desc()))).scalars().all()
    by_link: dict[int, list[Device]] = {}
    q = select(Device).where(Device.revoked_at.is_(None)).order_by(Device.last_seen_at.desc())
    for d in (await db.execute(q)).scalars():
        by_link.setdefault(d.link_id, []).append(d)
    return [await _link(l, by_link.get(l.id)) for l in rows]


@router.delete("/links/{link_id}/devices/{device_id}")
async def remove_device(link_id: int, device_id: int, db: AsyncSession = Depends(get_db)):
    """Sign a device out and free its slot. It can come back by opening the invite link again (if there's room)."""
    d = await db.get(Device, device_id)
    if not d or d.link_id != link_id or d.revoked_at:
        raise HTTPException(404, {"code": "NOT_FOUND", "message": "No such device"})
    d.revoked_at = datetime.now(timezone.utc)
    await db.commit()
    await devs.forget(d.session_hash)
    return {"ok": True}


@router.post("/links")
async def create_link(body: NewLink, db: AsyncSession = Depends(get_db)):
    token = new_token()
    link = Link(label=body.label.strip(), token_hash=hash_token(token), token_enc=encrypt(token))
    db.add(link)
    await db.commit()
    return await _link(link)


@router.post("/links/{link_id}/rotate")
async def rotate(link_id: int, db: AsyncSession = Depends(get_db)):
    """Issue a new URL for a link (e.g. one made before URLs were kept). The old URL stops working; anyone
    already signed in with it stays signed in, since sessions belong to the link, not the URL."""
    link = await db.get(Link, link_id)
    if not link or link.revoked_at:
        raise HTTPException(404, {"code": "NOT_FOUND", "message": "No such active link"})
    token = new_token()
    link.token_hash, link.token_enc = hash_token(token), encrypt(token)
    await db.commit()
    return await _link(link)


@router.delete("/links/{link_id}")
async def revoke(link_id: int, db: AsyncSession = Depends(get_db)):
    link = await db.get(Link, link_id)
    if not link:
        raise HTTPException(404, {"code": "NOT_FOUND", "message": "No such link"})
    link.revoked_at = datetime.now(timezone.utc)
    await db.commit()
    await redis.delete(f"link:{link_id}")  # takes effect immediately
    return await _link(link)


# --- settings ----------------------------------------------------------------------


@router.get("/settings/quality")
async def get_quality():
    return await store.quality()


@router.put("/settings/quality")
async def put_quality(body: store.Quality):
    await store.put("quality", body.model_dump())
    async for k in redis.scan_iter("streams:*"):
        await redis.delete(k)
    return body


@router.get("/settings/indexers")
async def get_indexers():
    return await store.indexers()


@router.put("/settings/indexers")
async def put_indexers(body: list[store.Indexer]):
    for ix in body:
        if not ix.url.startswith(("http://", "https://")):
            raise HTTPException(422, {"code": "URL", "message": f"{ix.name}: URL must start with http(s)://"})
    if len({ix.name for ix in body}) != len(body):
        raise HTTPException(422, {"code": "DUP", "message": "Indexer names must be unique"})
    await store.put("indexers", [ix.model_dump() for ix in body])
    async for k in redis.scan_iter("ix:down:*"):
        await redis.delete(k)
    async for k in redis.scan_iter("streams:*"):
        await redis.delete(k)
    return body


class KeyBody(BaseModel):
    key: str = Field(min_length=8, max_length=400)


@router.put("/settings/torbox")
async def set_torbox_key(body: KeyBody):
    key = body.key.strip()
    try:
        me = await torbox.user_me(key=key)  # validate before saving
    except torbox.TorBoxError as e:
        raise HTTPException(422, {"code": e.code, "message": e.detail or "TorBox rejected this key"})
    await store.put("torbox_key", key, secret=True)
    await redis.delete("tb:me")
    await library.clear()
    asyncio.create_task(_resync())
    return {"ok": True, "plan": me.get("plan")}


async def _resync() -> None:
    try:
        await library.sync()
    except Exception:  # noqa: BLE001
        pass


@router.put("/settings/tmdb")
async def set_tmdb_key(body: KeyBody):
    key = body.key.strip()
    headers, params = ({"Authorization": f"Bearer {key}"}, {}) if key.startswith("eyJ") else ({}, {"api_key": key})
    r = await client().get(cfg.tmdb_base_url + "/configuration", headers=headers, params=params)
    if r.status_code != 200:
        raise HTTPException(422, {"code": "TMDB_KEY", "message": "TMDB rejected this key"})
    await store.put("tmdb_key", key, secret=True)
    return {"ok": True}


class PasswordChange(BaseModel):
    current: str = Field(max_length=200)
    new: str = Field(min_length=10, max_length=200)


@router.put("/settings/password")
async def change_password(body: PasswordChange, request: Request):
    """Change the admin password. Asks for the current one again, so an unlocked tab left open can't be used to
    take the panel over."""
    if cfg.cf_access_team and cfg.cf_access_aud:
        raise HTTPException(409, {"code": "ACCESS_MODE", "message": "Sign-in is handled by Cloudflare Access, so there's no password to change."})
    if cfg.admin_token:
        raise HTTPException(409, {"code": "ENV_TOKEN", "message": "The password comes from ADMIN_TOKEN in .env. Change it there and restart."})
    stored = await store.get("admin_password")
    if not stored or not await check_password(body.current, stored):
        await _admin_fail(request)  # counts toward the same lockout as the sign-in form
        raise HTTPException(422, {"code": "WRONG_PASSWORD", "message": "Your current password is wrong."})
    if body.new == body.current:
        raise HTTPException(422, {"code": "SAME_PASSWORD", "message": "Choose a different password."})
    await store.put("admin_password", hash_password(body.new))
    return {"ok": True}


class UrlBody(BaseModel):
    url: str = Field(max_length=200)


@router.get("/settings/general")
async def get_general():
    return {"watch_url": (await store.get("watch_url")) or cfg.public_watch_url}


@router.put("/settings/general")
async def set_general(body: UrlBody):
    u = body.url.strip().rstrip("/")
    if not u.startswith(("http://", "https://")):
        raise HTTPException(422, {"code": "URL", "message": "Must start with http:// or https://"})
    await store.put("watch_url", u)
    return {"ok": True}


@router.get("/settings/keys")
async def keys_status():
    tb, tm = await store.torbox_key(), await store.tmdb_key()
    return {
        "torbox": {"set": bool(tb), "last4": tb[-4:] if tb else "", "source": "admin" if await store.get("torbox_key") else ("env" if tb else "")},
        "tmdb": {"set": bool(tm), "last4": tm[-4:] if tm else "", "source": "admin" if await store.get("tmdb_key") else ("env" if tm else "")},
    }
