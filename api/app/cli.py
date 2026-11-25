"""Owner CLI:  docker compose exec api python -m app.cli create-link "Sami"
                                                      list-links | revoke <id> | reset-admin-password | set-admin-password"""

import asyncio
import getpass
import sys
from datetime import datetime, timezone

from sqlalchemy import select

from . import settings_store as store
from .config import cfg
from .db import SessionLocal, init_db
from .models import Link
from .rds import redis
from .security import encrypt, hash_password, hash_token, new_token


async def main(argv: list[str]) -> int:
    await init_db()
    cmd = argv[0] if argv else ""
    async with SessionLocal() as s:
        if cmd == "create-link" and len(argv) > 1:
            token = new_token()
            s.add(Link(label=" ".join(argv[1:]), token_hash=hash_token(token), token_enc=encrypt(token)))
            await s.commit()
            print(f"{cfg.public_watch_url.rstrip('/')}/j/{token}")
        elif cmd == "list-links":
            for l in (await s.execute(select(Link).order_by(Link.id))).scalars():
                print(f"{l.id:>3}  {'REVOKED' if l.revoked_at else 'active ':7}  {l.label}  plays={l.play_count}")
        elif cmd == "revoke" and len(argv) > 1:
            link = await s.get(Link, int(argv[1]))
            if not link:
                print("no such link")
                return 1
            link.revoked_at = datetime.now(timezone.utc)
            await s.commit()
            await redis.delete(f"link:{link.id}")
            print(f"revoked {link.label}")
        elif cmd == "reset-admin-password":
            await store.remove("admin_password")  # the next visit to admin asks for a new one
            await redis.delete("admin:setup_lock")
            print("Admin password cleared. Open the admin panel to choose a new one.")
        elif cmd == "set-admin-password":
            if cfg.admin_token or (cfg.cf_access_team and cfg.cf_access_aud):
                print("Admin authentication is controlled by environment configuration.")
                return 1
            if not sys.stdin.isatty():
                print("An interactive terminal is required. Run without -T.")
                return 1
            password = getpass.getpass("New admin password: ")
            if not 10 <= len(password) <= 200:
                print("Password must be 10–200 characters.")
                return 1
            if password != getpass.getpass("Confirm password: "):
                print("Passwords do not match. No changes made.")
                return 1
            await store.put("admin_password", hash_password(password))
            print("Admin password updated. Log in with your new password.")
        else:
            print(__doc__)
            return 2
    await redis.aclose()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
