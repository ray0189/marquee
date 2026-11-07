"""Per-link device limit. A device is one signed-in browser, identified by a hash of its session token."""

from datetime import datetime, timezone

from fastapi import HTTPException, Request
from sqlalchemy import func, select, update

from .config import cfg
from .db import SessionLocal
from .models import Device
from .rds import redis
from .security import client_ip, hash_token

FULL = "This link is already in use on {n} devices. Ask the owner to free one up."


def full_error() -> HTTPException:
    return HTTPException(403, {"code": "DEVICE_LIMIT", "message": FULL.format(n=cfg.max_devices)})


async def active_count(s, link_id: int) -> int:
    q = select(func.count()).select_from(Device).where(Device.link_id == link_id, Device.revoked_at.is_(None))
    return (await s.execute(q)).scalar_one()


async def register(s, link_id: int, session: str, request: Request) -> None:
    s.add(Device(link_id=link_id, session_hash=hash_token(session), ip=client_ip(request),
                 user_agent=request.headers.get("user-agent", "")[:300], last_seen_at=datetime.now(timezone.utc)))


async def check(link_id: int, session: str, request: Request) -> None:
    """Allow a known device; register an unknown one (sessions from before the limit existed) if there's room."""
    h = hash_token(session)
    key = f"dev:{h}"
    cached = await redis.get(key)
    if cached == b"1" or cached == "1":
        return
    if cached in (b"0", "0"):
        raise HTTPException(401, {"code": "DEVICE_REMOVED", "message": "This device was signed out. Open your invite link again."})
    async with SessionLocal() as s:
        dev = (await s.execute(select(Device).where(Device.session_hash == h))).scalar_one_or_none()
        if dev is None:
            if await active_count(s, link_id) >= cfg.max_devices:
                raise full_error()
            await register(s, link_id, session, request)
            ok = True
        else:
            ok = dev.revoked_at is None
            if ok:
                await s.execute(update(Device).where(Device.id == dev.id).values(
                    last_seen_at=datetime.now(timezone.utc), ip=client_ip(request)))
        await s.commit()
    await redis.setex(key, 300, "1" if ok else "0")
    if not ok:
        raise HTTPException(401, {"code": "DEVICE_REMOVED", "message": "This device was signed out. Open your invite link again."})


async def forget(session_hash: str) -> None:
    await redis.delete(f"dev:{session_hash}")
