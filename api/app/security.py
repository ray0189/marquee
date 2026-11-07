import asyncio
import base64
import hashlib
import secrets
import time

import jwt
from cryptography.fernet import Fernet
from fastapi import Request
from itsdangerous import URLSafeTimedSerializer

from .config import cfg
from .http import client

COOKIE = "mq"
MAX_AGE = 400 * 86400

_ser = URLSafeTimedSerializer(cfg.session_secret, salt="marquee-session")
_media = URLSafeTimedSerializer(cfg.session_secret, salt="marquee-media")
_urltok = URLSafeTimedSerializer(cfg.session_secret, salt="marquee-url")
URL_TOKEN_AGE = 6 * 3600  # long enough for subtitles turned on near the end of a long film
_fernet = Fernet(base64.urlsafe_b64encode(hashlib.sha256(("fernet:" + cfg.session_secret).encode()).digest()))


def sign_session(link_id: int) -> str:
    return _ser.dumps({"l": link_id, "n": secrets.token_hex(6)})  # n: each sign-in is its own device


def read_session(token: str) -> int | None:
    try:
        return int(_ser.loads(token, max_age=MAX_AGE)["l"])
    except Exception:
        return None


def new_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def encrypt(plain: str) -> str:
    return _fernet.encrypt(plain.encode()).decode()


def decrypt(blob: str) -> str:
    return _fernet.decrypt(blob.encode()).decode()


def client_ip(request: Request) -> str:
    """Real viewer IP. Caddy sets X-Real-IP itself (overwriting anything a client sends), resolving
    CF-Connecting-IP / X-Forwarded-For only when they come from a trusted proxy such as cloudflared,
    so reading the raw Cloudflare header here would let anyone forge their address."""
    v = request.headers.get("x-real-ip")
    if v:
        return v.strip()
    return request.client.host if request.client else ""


def is_https(request: Request) -> bool:
    return request.headers.get("x-forwarded-proto", request.url.scheme) == "https"


# --- Cloudflare Access -------------------------------------------------------

_jwks: dict = {"at": 0.0, "set": None}


def _team_base() -> str:
    team = cfg.cf_access_team.removesuffix(".cloudflareaccess.com")
    return f"https://{team}.cloudflareaccess.com"


async def verify_access_jwt(token: str) -> dict:
    base = _team_base()
    if _jwks["set"] is None or time.time() - _jwks["at"] > 3600:
        r = await client().get(base + "/cdn-cgi/access/certs")
        r.raise_for_status()
        _jwks["set"] = jwt.PyJWKSet.from_dict(r.json())
        _jwks["at"] = time.time()
    kid = jwt.get_unverified_header(token).get("kid")
    key = next((k for k in _jwks["set"].keys if k.key_id == kid), None)
    if key is None:
        _jwks["set"] = None  # force refetch next time (key rotation)
        raise ValueError("unknown signing key")
    return jwt.decode(token, key.key, algorithms=["RS256"], audience=cfg.cf_access_aud, issuer=base)


# --- admin password (scrypt; verified results cached briefly so panel polling stays cheap) ----

_ok_cache: dict[str, float] = {}


def hash_password(pw: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(pw.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return f"scrypt${salt.hex()}${dk.hex()}"


def _verify(pw: str, stored: str) -> bool:
    try:
        _, salt, dk = stored.split("$")
        got = hashlib.scrypt(pw.encode(), salt=bytes.fromhex(salt), n=2**14, r=8, p=1, dklen=32)
        return secrets.compare_digest(got.hex(), dk)
    except Exception:  # noqa: BLE001
        return False


async def check_password(pw: str, stored: str) -> bool:
    if not pw:
        return False
    key = hashlib.sha256((pw + stored).encode()).hexdigest()
    if _ok_cache.get(key, 0) > time.time():
        return True
    ok = await asyncio.to_thread(_verify, pw, stored)
    if ok:
        _ok_cache[key] = time.time() + 300
        if len(_ok_cache) > 50:
            _ok_cache.clear()
    return ok


def sign_media(torrent_id: int, file_id: int, link_id: int) -> str:
    """Opaque handle for the server-side download proxy; reveals nothing about the CDN link. Carries the
    invite link it was issued to, so revoking that link stops the stream too."""
    return _media.dumps([torrent_id, file_id, link_id])


def read_media(sig: str) -> tuple[int, int, int] | None:
    try:
        a, b, c = _media.loads(sig, max_age=12 * 3600)
        return int(a), int(b), int(c)
    except Exception:
        return None


def sign_url_token(link_id: int) -> str:
    """Short-lived stand-in for the session, for URLs the browser fetches itself (EventSource, <track>).
    The 400-day session never goes in a URL, where it would land in proxy logs and browser history."""
    return _urltok.dumps({"l": link_id})


def read_url_token(tok: str) -> int | None:
    try:
        return int(_urltok.loads(tok, max_age=URL_TOKEN_AGE)["l"])
    except Exception:
        return None
