"""Background jobs: library index sync (every 5 min) and TMDB -> Meilisearch ingest (daily)."""

import asyncio
import logging
import time

from . import library, search, tmdb, torbox
from .config import cfg
from .db import init_db
from .rds import redis

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("marquee.worker")


async def library_loop() -> None:
    while True:
        try:
            res = await library.sync()
            log.info("library sync: %s", res)
        except torbox.TorBoxError as e:
            log.warning("library sync skipped: %s", e)
        except Exception:  # noqa: BLE001
            log.exception("library sync failed")
        await asyncio.sleep(300)


async def ingest() -> None:
    sem = asyncio.Semaphore(6)
    total = 0

    async def page(mt: str, sort: str, n: int) -> None:
        nonlocal total
        async with sem:
            try:
                params = {"sort_by": sort, "page": n, "include_adult": "false"}
                if sort.startswith("vote_count"):
                    params["vote_count.gte"] = 500
                data = await tmdb.req(f"/discover/{mt}", params, ttl=0)
            except Exception as e:  # noqa: BLE001
                log.debug("ingest page failed %s %s %s: %s", mt, sort, n, e)
                return
        cards = tmdb.cards(data.get("results", []), mt)
        await search.upsert(cards)
        total += len(cards)

    jobs = []
    for mt in ("movie", "tv"):
        jobs += [page(mt, "popularity.desc", n) for n in range(1, cfg.ingest_pages + 1)]
        jobs += [page(mt, "vote_count.desc", n) for n in range(1, 101)]
    await asyncio.gather(*jobs)
    await redis.set("search:last_ingest", str(int(time.time())))
    log.info("search ingest finished: ~%d titles upserted", total)


async def ingest_loop() -> None:
    while True:
        try:
            if await search.ensure_index():
                last = await redis.get("search:last_ingest")
                empty = (await search.count() or 0) == 0
                if empty or not last or time.time() - int(last) > 86400:
                    log.info("starting search ingest")
                    await ingest()
            else:
                log.warning("meilisearch not reachable, retrying")
        except Exception:  # noqa: BLE001
            log.exception("ingest failed")
        await asyncio.sleep(3600)


async def main() -> None:
    await init_db()
    await asyncio.gather(library_loop(), ingest_loop())


if __name__ == "__main__":
    asyncio.run(main())
