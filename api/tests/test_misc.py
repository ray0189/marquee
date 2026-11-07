import asyncio

import pytest

from app import limiter
from app.indexers import parse_streams
from app.resolver import rank
from app.settings_store import Quality
from app.subtitles import host_allowed, srt_to_vtt
from app.torbox import _present


def test_srt_to_vtt():
    srt = "﻿1\r\n00:00:01,500 --> 00:00:03,000\r\n<font color=red>Hello</font>\r\n"
    out = srt_to_vtt(srt)
    assert out.startswith("WEBVTT\n\n")
    assert "00:00:01.500 --> 00:00:03.000" in out and "<font" not in out
    assert srt_to_vtt("WEBVTT\n\nx") == "WEBVTT\n\nx"


def test_subtitle_host_allowlist():
    assert host_allowed("https://subs5.strem.io/a.srt")
    assert host_allowed("https://dl.opensubtitles.org/x")
    assert not host_allowed("http://subs5.strem.io/a.srt")  # https only
    assert not host_allowed("https://evilstrem.io/a.srt")  # suffix trick
    assert not host_allowed("https://127.0.0.1/a.srt")
    assert not host_allowed("https://strem.io.evil.com/a")


def test_torbox_present_accepts_dict_and_list():
    assert _present({"ABC": {"name": "x"}, "def": None}) == {"abc"}
    assert _present(["AAA", {"hash": "BBB"}]) == {"aaa", "bbb"}
    assert _present(None) == set() and _present(False) == set()


def test_parse_streams_torrentio_shape():
    data = {"streams": [
        {"name": "Torrentio\n4k", "title": "Movie.2160p.WEB-DL\n👤 12 💾 45.5 GB ⚙️ TPB", "infoHash": "A" * 40,
         "behaviorHints": {"filename": "Movie.2160p.WEB-DL.mkv"}},
        {"title": "no hash"},
        {"title": "short", "infoHash": "abc"},
    ]}
    (c,) = parse_streams(data, "torrentio")
    assert c.hash == "a" * 40 and c.seeders == 12 and c.size == 45_500_000_000 and c.filename.endswith(".mkv")


def test_rank_ranks_before_filtering_and_hides_uncached():
    from app.indexers import Candidate

    q = Quality().model_dump()
    pool = {
        "a": Candidate("a" * 40, title="Movie.1080p.WEB-DL.x264", cached=True),
        "b": Candidate("b" * 40, title="Movie.2160p.REMUX.HEVC", cached=True),
        "c": Candidate("c" * 40, title="Movie.2160p.REMUX.HEVC.v2", cached=False),
        "d": Candidate("d" * 40, title="Movie.2024.HDCAM", cached=True),
    }
    items, hidden = rank(pool, q)
    assert [i["hash"][0] for i in items] == ["b", "a"] and hidden == 1


def test_rank_relaxes_min_resolution_when_nothing_else():
    from app.indexers import Candidate

    pool = {"a": Candidate("a" * 40, title="Old.Film.480p.DVDRip", cached=True)}
    items, _ = rank(pool, Quality().model_dump())
    assert len(items) == 1



def test_rank_drops_unconfirmed_library_film_once_indexers_answer():
    from app.indexers import Candidate

    pool = {
        "a": Candidate("a" * 40, title="The.Odyssey.2026.1080p.WEB-DL", cached=True, owned=True, indexers={"library"}),
        "b": Candidate("b" * 40, title="The.Odyssey.2026.2160p.WEB-DL", cached=True, indexers={"torrentio"}),
    }
    q = Quality().model_dump()
    assert {i["hash"][0] for i in rank(pool, q, "movie", imdb_answered=True)[0]} == {"b"}
    assert {i["hash"][0] for i in rank(pool, q, "movie", imdb_answered=False)[0]} == {"a", "b"}  # indexers down: keep it
    assert {i["hash"][0] for i in rank(pool, q, "tv", imdb_answered=True)[0]} == {"a", "b"}

def test_rank_drops_releases_that_say_they_are_another_film():
    from app.indexers import Candidate

    pool = {
        "a": Candidate("a" * 40, title="The Odyssey 2026 (NOT The Chris Nolan FILM) 1080p WEB-DL", cached=True),
        "b": Candidate("b" * 40, title="The.Odyssey.2026.720p.TUBI.WEB-DL.AAC2.0-NOtLAN (NOT The Chris Nolan FILM)", cached=True),
        "c": Candidate("c" * 40, title="The.Odyssey.2026.1080p.WEB-DL", cached=True),
        "d": Candidate("d" * 40, title="Do.Not.Watch.This.Movie.2024.1080p.WEB-DL", cached=True),
    }
    assert {i["hash"][0] for i in rank(pool, Quality().model_dump())[0]} == {"c", "d"}


def test_limiter_budget_and_wait():
    redis = pytest.importorskip("redis.asyncio").Redis.from_url("redis://localhost:6379/15", decode_responses=True)

    async def run():
        await redis.delete("rl:t")
        for _ in range(3):
            await limiter.acquire(redis, "t", 3, 400)
        with pytest.raises(limiter.RateLimited):
            await limiter.acquire(redis, "t", 3, 400)
        await limiter.acquire(redis, "t", 3, 400, max_wait_ms=1000)  # waits for the window, then succeeds
        assert await limiter.usage(redis, "t", 400) >= 1
        await redis.delete("rl:t")
        await redis.aclose()

    try:
        asyncio.run(run())
    except (OSError, pytest.importorskip("redis.exceptions").ConnectionError):
        pytest.skip("no redis on localhost")


def test_search_rerank_prefers_title_matches_then_popularity():
    from app.search import rerank

    items = [
        {"title": "Odyssey", "popularity": 2},
        {"title": "Iron Man 3", "popularity": 19, "overview": "... an odyssey of self-discovery"},
        {"title": "The Odyssey", "popularity": 188},
        {"title": "2001: A Space Odyssey", "popularity": 17},
        {"title": "Odyssey 5", "popularity": 5},
        {"title": "Doctor Odyssey", "popularity": 14},
        {"title": "A Korean Odyssey", "popularity": 8},
    ]
    got = [i["title"] for i in rerank("odyssey", items, 10)]
    assert got[:2] == ["The Odyssey", "Odyssey"]
    assert "Iron Man 3" not in got  # overview-only match dropped once titles suffice
