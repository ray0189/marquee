import hmac
import json
from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import HTTPException, Request
from sqlalchemy import update

from . import devices, limiter, security, settings_store as store
from .config import cfg
from .db import SessionLocal
from .models import Link
from .rds import redis
from .security import COOKIE, read_session, verify_access_jwt


@dataclass
class LinkInfo:
    id: int
    label: str


def _deny(status: int, code: str, message: str, **extra) -> HTTPException:
    return HTTPException(status, {"code": code, "message": message, **extra})


async def _link_state(lid: int) -> dict:
    raw = await redis.get(f"link:{lid}")
    if raw:
        return json.loads(raw)
    async with SessionLocal() as s:
        link = await s.get(Link, lid)
    state = {"ok": bool(link and not link.revoked_at), "label": link.label if link else ""}
    await redis.setex(f"link:{lid}", 60, json.dumps(state))
    return state


async def require_link(request: Request) -> LinkInfo:
    # The cookie is the normal route. Some browsers/devices drop it (private modes, in-app browsers,
    # strict tracking protection), so the same signed value is also accepted as a header. URLs the browser
    # fetches itself (EventSource, <track>) can't carry headers: they get a short-lived token (mq_t) instead.
    raw = request.cookies.get(COOKIE) or request.headers.get("x-mq-session")
    lid = read_session(raw) if raw else None
    if lid is not None:
        await devices.check(lid, raw, request)
    elif (t := request.query_params.get("mq_t")):
        lid = security.read_url_token(t)
    if lid is None:
        raise _deny(401, "NO_LINK", "Ask for an invite link to get in.")
    state = await _link_state(lid)
    if not state["ok"]:
        raise _deny(401, "REVOKED", "This invite link is no longer active.")
    try:
        await limiter.acquire(redis, f"link:{lid}", cfg.link_rate_per_min, 60_000)
    except limiter.RateLimited:
        raise _deny(429, "SLOW_DOWN", "Too many requests, slow down a little.")
    if await redis.set(f"seen:{lid}", "1", nx=True, ex=300):
        async with SessionLocal() as s:
            await s.execute(update(Link).where(Link.id == lid).values(last_seen_at=datetime.now(timezone.utc)))
            await s.commit()
    return LinkInfo(lid, state["label"])


async def require_admin(request: Request) -> dict:
    """Cloudflare Access JWT when configured; otherwise a static token. Never open by default."""
    if cfg.cf_access_team and cfg.cf_access_aud:
        tok = request.headers.get("cf-access-jwt-assertion") or request.cookies.get("CF_Authorization")
        if not tok:
            raise _deny(403, "ACCESS_REQUIRED", "Sign in through Cloudflare Access.", mode="access")
        try:
            claims = await verify_access_jwt(tok)
        except Exception:
            raise _deny(403, "ACCESS_INVALID", "Cloudflare Access token rejected.", mode="access")
        if cfg.admin_email and str(claims.get("email", "")).lower() != cfg.admin_email.lower():
            raise _deny(403, "ACCESS_EMAIL", "This account isn't the owner.", mode="access")
        return {"mode": "access", "email": claims.get("email")}
    got = request.headers.get("x-admin-token", "")
    await _admin_locked(request)
    if cfg.admin_token:  # optional override from the environment
        if hmac.compare_digest(got.encode(), cfg.admin_token.encode()):
            return {"mode": "token"}
        await _admin_fail(request)
    else:
        stored = await store.get("admin_password")
        if not stored:
            raise _deny(503, "ADMIN_SETUP", "Create your admin password to continue.", mode="setup")
        if await security.check_password(got, stored):
            return {"mode": "password"}
        await _admin_fail(request)
    raise _deny(401, "ADMIN_TOKEN", "Admin password required.", mode="token")


ADMIN_FAIL_LIMIT = 8


async def _admin_locked(request: Request) -> None:
    """Refuse before checking the password while an IP is locked out, so guessing can't continue."""
    if await limiter.usage(redis, f"adminfail:{security.client_ip(request)}", 60_000) >= ADMIN_FAIL_LIMIT:
        raise _deny(429, "SLOW_DOWN", "Too many attempts. Wait a minute.", mode="token")


async def _admin_fail(request: Request) -> None:
    """Count a failed attempt; too many from one IP in a minute locks that IP out briefly."""
    try:
        await limiter.acquire(redis, f"adminfail:{security.client_ip(request)}", ADMIN_FAIL_LIMIT, 60_000)
    except limiter.RateLimited:
        raise _deny(429, "SLOW_DOWN", "Too many attempts. Wait a minute.", mode="token")
