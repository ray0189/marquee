import os

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


_SECRET_FILE = "/data/session_secret"


class Config(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # core
    session_secret: str = Field("", validate_default=True)
    database_url: str = "sqlite+aiosqlite:///./marquee.db"
    redis_url: str = "redis://localhost:6379/0"
    meili_url: str = "http://localhost:7700"
    meili_master_key: str = ""
    public_watch_url: str = "http://localhost:8080"

    # upstreams (keys can also be set later from the admin panel)
    torbox_api_key: str = ""
    torbox_base_url: str = "https://api.torbox.app/v1/api"
    tmdb_api_key: str = ""
    tmdb_base_url: str = "https://api.themoviedb.org/3"

    # admin auth: Cloudflare Access (preferred) or a static token
    cf_access_team: str = ""
    cf_access_aud: str = ""
    admin_email: str = ""
    admin_token: str = ""

    # budgets
    limit_per_min: int = 280
    limit_adds_per_hour: int = 55
    link_rate_per_min: int = 600
    max_devices: int = 5  # per invite link

    # discovery
    # Same public addons AIOStreams uses. Comet and StremThru Torz take their settings as base64 JSON in the URL;
    # these ask for plain torrent hashes (no debrid key), since Marquee checks TorBox's cache itself.
    indexer_urls: str = (
        "https://torrentio.strem.fun,https://torrentsdb.com,"
        "https://comet.feels.legal/eyJtYXhSZXN1bHRzUGVyUmVzb2x1dGlvbiI6MCwibWF4U2l6ZSI6MCwiY2FjaGVkT25seSI6ZmFsc2UsInJlbW92ZVRyYXNoIjp0cnVlLCJyZXN1bHRGb3JtYXQiOlsiYWxsIl0sImRlYnJpZFNlcnZpY2UiOiJ0b3JyZW50IiwiZGVicmlkQXBpS2V5IjoiIiwiZGVicmlkU3RyZWFtUHJveHlQYXNzd29yZCI6IiIsImxhbmd1YWdlcyI6eyJyZXF1aXJlZCI6W10sImV4Y2x1ZGUiOltdLCJwcmVmZXJyZWQiOltdfSwicmVzb2x1dGlvbnMiOnt9LCJvcHRpb25zIjp7InJlbW92ZV9yYW5rc191bmRlciI6LTEwMDAwMDAwMDAwLCJhbGxvd19lbmdsaXNoX2luX2xhbmd1YWdlcyI6ZmFsc2UsInJlbW92ZV91bmtub3duX2xhbmd1YWdlcyI6ZmFsc2V9fQ==,"
        "https://stremthru.13377001.xyz/stremio/torz/eyJzdG9yZXMiOlt7ImMiOiJwMnAiLCJ0IjoiIn1dfQ==,"
        "https://stremthru.elfhosted.com/stremio/torz/eyJzdG9yZXMiOlt7ImMiOiJwMnAiLCJ0IjoiIn1dfQ=="
    )  # the public Knightcrawler instance shut down (now redirects to docs)
    subtitle_hosts: str = "strem.io,opensubtitles.org,opensubtitles.com"
    ingest_pages: int = 250

    @field_validator("session_secret")
    @classmethod
    def _strong(cls, v: str) -> str:
        # `docker compose exec` skips the entrypoint that exports the generated secret, so read it directly.
        if not v and os.path.isfile(_SECRET_FILE):
            with open(_SECRET_FILE) as f:
                v = f.read().strip()
        if len(v) < 24 or "change" in v.lower():
            raise ValueError("SESSION_SECRET must be a random string of 24+ characters (openssl rand -hex 32)")
        return v


cfg = Config()
