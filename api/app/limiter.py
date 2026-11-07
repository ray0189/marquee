"""Sliding-window rate limiter on Redis sorted sets (atomic via Lua)."""

import asyncio
import time
import uuid

from redis.asyncio import Redis

_LUA = """
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window)
  return {1, 0}
end
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
return {0, tonumber(oldest[2]) + window - now}
"""

_scripts: dict[int, object] = {}


class RateLimited(Exception):
    def __init__(self, retry_after_ms: int):
        super().__init__(f"rate limited, retry in {retry_after_ms} ms")
        self.retry_after_ms = retry_after_ms


def _script(redis: Redis):
    s = _scripts.get(id(redis))
    if s is None:
        s = redis.register_script(_LUA)
        _scripts[id(redis)] = s
    return s


async def acquire(redis: Redis, name: str, limit: int, window_ms: int, max_wait_ms: int = 0) -> None:
    """Take one slot. Waits up to max_wait_ms for room, otherwise raises RateLimited."""
    started = time.monotonic()
    while True:
        now = int(time.time() * 1000)
        ok, wait = await _script(redis)(
            keys=[f"rl:{name}"], args=[now, window_ms, limit, f"{now}:{uuid.uuid4().hex[:8]}"]
        )
        if int(ok) == 1:
            return
        wait = max(int(wait), 1)
        waited = (time.monotonic() - started) * 1000
        if waited + wait > max_wait_ms:
            raise RateLimited(wait)
        await asyncio.sleep(min(wait, 1000) / 1000 + 0.01)


async def usage(redis: Redis, name: str, window_ms: int) -> int:
    now = int(time.time() * 1000)
    return int(await redis.zcount(f"rl:{name}", now - window_ms, "+inf"))
