from collections.abc import AsyncIterator

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from .config import cfg

engine = create_async_engine(cfg.database_url, pool_pre_ping=True)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def init_db() -> None:
    from . import models  # noqa: F401  (register tables)

    async with engine.begin() as conn:
        if conn.dialect.name == "postgresql":
            # Two API workers and the worker process all start together; one at a time creates the schema
            # (the lock is released when this transaction ends).
            await conn.execute(text("SELECT pg_advisory_xact_lock(7240531)"))
        await conn.run_sync(Base.metadata.create_all)
        await conn.run_sync(_add_missing_columns)


def _add_missing_columns(conn) -> None:
    """create_all never alters existing tables; add columns introduced after a database was created."""
    from sqlalchemy import inspect, text

    if conn.dialect.name == "postgresql":
        # IF NOT EXISTS: the API runs two workers that start together and both get here.
        conn.execute(text("ALTER TABLE links ADD COLUMN IF NOT EXISTS token_enc TEXT"))
        return
    if "token_enc" not in {c["name"] for c in inspect(conn).get_columns("links")}:
        conn.execute(text("ALTER TABLE links ADD COLUMN token_enc TEXT"))


async def get_db() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        yield session
