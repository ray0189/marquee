import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from . import http, torbox
from .db import init_db
from .rds import redis
from .routes import admin, setup, watch

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield
    await http.close()
    await redis.aclose()


app = FastAPI(title="Marquee", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
app.include_router(watch.router, prefix="/api")
app.include_router(setup.router, prefix="/api/admin/setup")
app.include_router(admin.router, prefix="/api/admin")


@app.get("/api/health")
async def health():
    await redis.ping()
    return {"ok": True}


@app.middleware("http")
async def headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["X-Robots-Tag"] = "noindex, nofollow"
    resp.headers.setdefault("Cache-Control", "no-store")
    return resp


@app.exception_handler(torbox.TorBoxError)
async def torbox_error(request: Request, exc: torbox.TorBoxError):
    if isinstance(exc, torbox.TorBoxRateLimited):
        return JSONResponse(status_code=429, content={"detail": {"code": exc.code, "message": "Busy right now, try again in a moment."}})
    if isinstance(exc, torbox.TorBoxAuthError):
        return JSONResponse(status_code=503, content={"detail": {"code": exc.code, "message": "The server's TorBox key isn't working. Tell the owner."}})
    return JSONResponse(status_code=502, content={"detail": {"code": exc.code, "message": exc.detail or "TorBox returned an error."}})
