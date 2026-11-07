"""Owner CLI:  docker compose exec api python -m app.cli create-link "Sami"
                                                      list-links | revoke <id> | reset-admin-password"""

import asyncio
import sys
from datetime import datetime, timezone

from sqlalchemy import select

from . import settings_store as store
from .config import cfg
from .db import SessionLocal, init_db
from .models import Link
from .rds import redis
from .security import encrypt, hash_token, new_token


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
            print("Admin password cleared. Open the admin panel to choose a new one.")
        else:
            print(__doc__)
            return 2
    await redis.aclose()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
