import logging

import httpx

# httpx logs every request URL at INFO, and ours carry secrets (TMDB api_key=, TorBox requestdl token=).
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

_client: httpx.AsyncClient | None = None


def client() -> httpx.AsyncClient:
    """One shared async client (HTTP/2, pooled) for every outbound call."""
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            http2=True,
            timeout=httpx.Timeout(20.0, connect=8.0),
            limits=httpx.Limits(max_connections=100, max_keepalive_connections=30),
            headers={"User-Agent": "Marquee/1.0"},
            follow_redirects=False,
        )
    return _client


async def close() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None
