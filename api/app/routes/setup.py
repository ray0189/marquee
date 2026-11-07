"""First-run admin setup. Lives under /api/admin/setup so the watch host never exposes it."""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .. import limiter, security, settings_store as store
from ..config import cfg
from ..rds import redis

router = APIRouter()


@router.get("/state")
async def state():
    if cfg.cf_access_team and cfg.cf_access_aud:
        return {"mode": "access"}
    if cfg.admin_token or await store.get("admin_password"):
        return {"mode": "login"}
    return {"mode": "setup"}


class Pw(BaseModel):
    password: str = Field(min_length=10, max_length=200)


@router.post("/password")
async def create_password(body: Pw, request: Request):
    try:
        await limiter.acquire(redis, f"adminsetup:{security.client_ip(request)}", 10, 60_000)
    except limiter.RateLimited:
        raise HTTPException(429, {"code": "SLOW_DOWN", "message": "Too many attempts."})
    # SET NX in Redis makes the first writer win even if two browsers race.
    if cfg.admin_token or not await redis.set("admin:setup_lock", "1", nx=True):
        raise HTTPException(409, {"code": "ALREADY_SET", "message": "An admin password already exists."})
    if await store.get("admin_password"):
        raise HTTPException(409, {"code": "ALREADY_SET", "message": "An admin password already exists."})
    try:
        await store.put("admin_password", security.hash_password(body.password))
    except Exception:
        await redis.delete("admin:setup_lock")
        raise
    return {"ok": True}
