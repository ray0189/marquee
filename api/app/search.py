"""Meilisearch via its REST API. Every function degrades to 'nothing' if Meili is down,
so search falls back to TMDB instead of failing."""

import logging
import math
import re

from .config import cfg
from .http import client

log = logging.getLogger("marquee.search")
INDEX = "titles"


def _h() -> dict:
    return {"Authorization": f"Bearer {cfg.meili_master_key}"} if cfg.meili_master_key else {}


async def ensure_index() -> bool:
    try:
        c = client()
        await c.post(f"{cfg.meili_url}/indexes", json={"uid": INDEX, "primaryKey": "id"}, headers=_h())
        r = await c.patch(
            f"{cfg.meili_url}/indexes/{INDEX}/settings",
            headers=_h(),
            json={
                "searchableAttributes": ["title", "original_title", "overview"],
                "filterableAttributes": ["type", "year"],
                "sortableAttributes": ["popularity"],
                "rankingRules": ["words", "typo", "proximity", "attribute", "sort", "exactness", "popularity:desc"],
            },
        )
        return r.status_code < 300
    except Exception as e:
        log.warning("meilisearch unavailable: %s", e)
        return False


def doc(card: dict) -> dict:
    return {**card, "id": f"{card['type']}-{card['id']}", "tmdb_id": card["id"], "original_title": card.get("original_title", "")}


async def upsert(cards: list[dict]) -> None:
    if not cards:
        return
    try:
        await client().post(
            f"{cfg.meili_url}/indexes/{INDEX}/documents?primaryKey=id",
            json=[doc(c) for c in cards],
            headers=_h(),
            timeout=60,
        )
    except Exception as e:
        log.warning("meili upsert failed: %s", e)


def _norm(s: str) -> str:
    s = re.sub(r"[^\w\s]", " ", (s or "").lower())
    return re.sub(r"\s+", " ", s).strip()


def match_tier(q: str, it: dict) -> int:
    """0 exact title ("odyssey" == "The Odyssey"), 1 title starts with it, 2 all words in the title,
    3 matched only in the overview or by typo tolerance."""
    nq = _norm(q)
    names = {_norm(it.get("title", "")), _norm(it.get("original_title", ""))} - {""}
    bare = {re.sub(r"^(the|a|an) ", "", n) for n in names}
    if nq in names or re.sub(r"^(the|a|an) ", "", nq) in bare:
        return 0
    if any(n.startswith(nq) for n in names | bare):
        return 1
    if any(all(re.search(rf"\b{re.escape(w)}", n) for w in nq.split()) for n in names):
        return 2
    return 3


def rerank(q: str, items: list[dict], limit: int) -> list[dict]:
    """Meili ranks word matches before popularity and also searches overviews, so an obscure exact title or a
    film that merely mentions the word beats the one people mean. Rank by how the TITLE matches, then popularity."""
    tier = lambda it: match_tier(q, it)  # noqa: E731
    scored = sorted(items, key=lambda it: (tier(it), -math.log1p(float(it.get("popularity") or 0))))
    titled = [it for it in scored if tier(it) < 3]
    return (titled if len(titled) >= 5 else scored)[:limit]


async def query(q: str, limit: int = 24, media_type: str | None = None) -> list[dict]:
    body: dict = {"q": q, "limit": limit * 2}  # over-fetch, then rerank
    if media_type:
        body["filter"] = f'type = "{media_type}"'
    try:
        r = await client().post(f"{cfg.meili_url}/indexes/{INDEX}/search", json=body, headers=_h(), timeout=4)
        r.raise_for_status()
        out = []
        for h in r.json().get("hits", []):
            h = dict(h)
            h["id"] = h.pop("tmdb_id", h["id"])
            out.append({k: v for k, v in h.items() if not k.startswith("_")})
        return rerank(q, out, limit)
    except Exception as e:
        log.debug("meili query failed: %s", e)
        return []


async def count() -> int | None:
    try:
        r = await client().get(f"{cfg.meili_url}/indexes/{INDEX}/stats", headers=_h(), timeout=3)
        return int(r.json().get("numberOfDocuments", 0)) if r.status_code == 200 else 0
    except Exception:
        return None
