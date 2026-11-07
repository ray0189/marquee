import asyncio

import httpx
import pytest

from app import indexers


class FakeRedis:
    def __init__(self):
        self.d, self.ttl = {}, {}

    async def set(self, k, v, ex=None):
        self.d[k], self.ttl[k] = v, ex

    async def incr(self, k):
        self.d[k] = int(self.d.get(k, 0)) + 1
        return self.d[k]

    async def expire(self, k, s):
        self.ttl[k] = s


def _err(status, headers=None):
    req = httpx.Request("GET", "https://x/stream")
    return httpx.HTTPStatusError("x", request=req, response=httpx.Response(status, headers=headers or {}, request=req))


def test_backoff(monkeypatch):
    r = FakeRedis()
    monkeypatch.setattr(indexers, "redis", r)
    run = lambda e: asyncio.run(indexers._pause("ix", e))  # noqa: E731
    run(TimeoutError())
    run(TimeoutError())
    assert "ix:down:ix" not in r.d  # two blips: still in service
    run(TimeoutError())
    assert r.ttl["ix:down:ix"] == 300  # third in a row: paused
    r2 = FakeRedis()
    monkeypatch.setattr(indexers, "redis", r2)
    run(_err(429, {"retry-after": "1200"}))
    assert r2.ttl["ix:down:ix"] == 1200  # rate limit honoured at once
    run(_err(429, {"retry-after": "99999"}))
    assert r2.ttl["ix:down:ix"] == 1800  # capped
