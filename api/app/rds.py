from redis.asyncio import Redis

from .config import cfg

redis = Redis.from_url(cfg.redis_url, decode_responses=True)
