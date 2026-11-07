"""One FastAPI app that imitates TorBox (/v1/api), TMDB (/3) and a Stremio indexer (/stream).
It models the response shapes Marquee expects. It is NOT the real TorBox: see scripts/verify_torbox.py for that."""

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

app = FastAPI()
KEY = "mock-key"

H_A, H_B, H_C, H_D, H_LIB, H_PACK = "a" * 40, "b" * 40, "c" * 40, "d" * 40, "1" * 40, "9" * 40
CACHED = {H_A, H_B, H_D, H_LIB, H_PACK}
stats: dict = {"checkcached": 0, "mylist": 0, "createtorrent": 0, "requestdl": 0, "createstream": 0, "last_requestdl": None, "create_content_type": None}


def vid(i, name, size):
    return {"id": i, "name": name, "short_name": name.rsplit("/", 1)[-1], "size": size, "mimetype": "video/x-matroska"}


LIBRARY = {
    1: {"id": 1, "hash": H_LIB, "name": "The.Matrix.1999.1080p.BluRay.x264", "size": 9_000_000_000,
        "files": [vid(0, "The.Matrix.1999.1080p.BluRay.x264/The.Matrix.1999.1080p.BluRay.x264.AC3.mkv" if __import__("os").environ.get("MOCK_DL_URL") else "The.Matrix.1999.1080p.BluRay.x264/The.Matrix.1999.1080p.BluRay.x264.mkv", 9_000_000_000)]},
}
PACK_FILES = [vid(i, f"Sample.Show.S01.1080p.WEB-DL/Sample.Show.S01E{i:02d}.1080p.WEB-DL.mkv", 1_000_000_000 + i) for i in range(1, 11)]
PACK_FILES.append(vid(99, "Sample.Show.S01.1080p.WEB-DL/Sample/sample.mkv", 5))
NEXT_ID = {"n": 100}


def env(data=None, ok=True, error=None, detail="ok", status=200):
    return JSONResponse(status_code=status, content={"success": ok, "error": error, "detail": detail, "data": data})


def authed(request: Request) -> bool:
    return request.headers.get("authorization") == f"Bearer {KEY}"


@app.get("/__stats")
async def get_stats():
    return stats


# --- TorBox ------------------------------------------------------------------------


@app.get("/v1/api/user/me")
async def me(request: Request):
    if not authed(request):
        return env(None, False, "BAD_TOKEN", "Invalid key", 403)
    return env({"plan": 2, "email": "owner@example.com", "premium_expires_at": "2027-01-01T00:00:00Z"})


@app.post("/v1/api/torrents/checkcached")
async def checkcached(request: Request):
    if not authed(request):
        return env(None, False, "BAD_TOKEN", "Invalid key", 403)
    body = await request.json()
    stats["checkcached"] += 1
    assert len(body["hashes"]) <= 100
    return env([h for h in body["hashes"] if h in CACHED])


@app.get("/v1/api/torrents/mylist")
async def mylist(request: Request, id: int | None = None, offset: int = 0, limit: int = 1000):
    stats["mylist"] += 1
    items = list(LIBRARY.values())
    if id is not None:
        return env(LIBRARY.get(id))
    return env(items[offset : offset + limit])


@app.post("/v1/api/torrents/createtorrent")
async def createtorrent(request: Request):
    stats["createtorrent"] += 1
    stats["create_content_type"] = request.headers.get("content-type", "")
    form = await request.form()
    magnet = str(form.get("magnet", ""))
    h = magnet.rsplit(":", 1)[-1].lower()
    if h not in CACHED:
        return env({"queued_id": 5}, True, None, "queued")
    NEXT_ID["n"] += 1
    tid = NEXT_ID["n"]
    files = PACK_FILES if h == H_PACK else [vid(0, f"{h[:6]}/{h[:6]}.mkv", 4_000_000_000)]
    LIBRARY[tid] = {"id": tid, "hash": h, "name": "Sample.Show.S01.1080p.WEB-DL" if h == H_PACK else f"Release.{h[:6]}", "size": 1, "files": files}
    return env({"torrent_id": tid, "hash": h})


@app.get("/v1/api/torrents/requestdl")
async def requestdl(request: Request):
    q = dict(request.query_params)
    stats["requestdl"] += 1
    stats["last_requestdl"] = q
    if q.get("token") != KEY:
        return env(None, False, "BAD_TOKEN", "Invalid key", 403)
    import os
    if os.environ.get("MOCK_DL_URL"):
        return env(os.environ["MOCK_DL_URL"])
    return env(f"https://cdn.mock.invalid/dl/{q['torrent_id']}/{q['file_id']}?t=signed-download-token")


@app.get("/v1/api/stream/createstream")
async def createstream(request: Request):
    q = dict(request.query_params)
    stats["createstream"] += 1
    return env({
        "hls_url": f"https://cdn.mock.invalid/hls/{q['id']}/{q['file_id']}/a{q.get('chosen_audio_index', 0)}/playlist.m3u8",
        "needs_transcoding": True,
        "metadata": {"audios": [{"index": 0, "language": "eng", "title": "English 5.1"}, {"index": 1, "language": "spa", "title": "Spanish"}],
                     "subtitles": [], "video": {"codec": "hevc"}},
    })


# --- indexer -----------------------------------------------------------------------


def s(h, title, filename, seeders, size_gb):
    return {"name": "Mock", "title": f"{title}\n👤 {seeders} 💾 {size_gb} GB ⚙️ Mock", "infoHash": h, "behaviorHints": {"filename": filename}}


@app.get("/stream/movie/{imdb}.json")
async def ix_movie(imdb: str):
    if imdb != "tt0133093":
        return {"streams": []}
    return {"streams": [
        s(H_A, "The.Matrix.1999.1080p.WEB-DL.x264.AAC", "The.Matrix.1999.1080p.WEB-DL.x264.AAC.mp4", 90, 3.2),
        s(H_B, "The.Matrix.1999.2160p.UHD.BluRay.REMUX.HDR.HEVC.DTS-HD", "The.Matrix.1999.2160p.REMUX.mkv", 200, 58),
        s(H_C, "The.Matrix.1999.2160p.WEB-DL.HEVC", "", 40, 20),
        s(H_D, "The.Matrix.1999.HDCAM.x264", "", 500, 1.4),
        s(H_LIB, "The.Matrix.1999.1080p.BluRay.x264", "", 30, 9),
    ]}


@app.get("/stream/series/{vid_id}.json")
async def ix_series(vid_id: str):
    if not vid_id.startswith("tt0944947"):
        return {"streams": []}
    return {"streams": [s(H_PACK, "Sample.Show.S01.1080p.WEB-DL", "", 70, 12)]}


# --- TMDB --------------------------------------------------------------------------

MATRIX = {"id": 603, "title": "The Matrix", "release_date": "1999-03-30", "poster_path": "/p.jpg", "backdrop_path": "/b.jpg",
          "overview": "A hacker learns the truth.", "vote_average": 8.2, "popularity": 90, "imdb_id": "tt0133093", "runtime": 136,
          "genres": [{"id": 28, "name": "Action"}], "tagline": "Welcome to the real world."}
SHOW = {"id": 1399, "name": "Sample Show", "first_air_date": "2011-04-17", "poster_path": "/p2.jpg", "backdrop_path": "/b2.jpg",
        "overview": "A sample.", "vote_average": 8.4, "popularity": 80, "genres": [{"id": 18, "name": "Drama"}], "episode_run_time": [55],
        "external_ids": {"imdb_id": "tt0944947"},
        "seasons": [{"season_number": 0, "name": "Specials", "episode_count": 2}, {"season_number": 1, "name": "Season 1", "episode_count": 10}]}


@app.get("/3/configuration")
async def tmdb_conf(api_key: str = ""):
    return {"images": {}} if api_key == "tmdb-mock" else JSONResponse(status_code=401, content={})


@app.get("/3/movie/{mid:int}")
async def tmdb_movie(mid: int):
    if mid == 603:
        return {**MATRIX, "external_ids": {"imdb_id": "tt0133093"}, "credits": {"cast": [{"name": "Keanu Reeves", "character": "Neo"}]},
                "recommendations": {"results": [{**MATRIX, "id": 604}]}, "release_dates": {"results": []}}
    return JSONResponse(status_code=404, content={})


@app.get("/3/tv/{tid:int}")
async def tmdb_tv(tid: int):
    return {**SHOW, "credits": {"cast": []}, "recommendations": {"results": []}, "content_ratings": {"results": []}} if tid == 1399 else JSONResponse(status_code=404, content={})


@app.get("/3/tv/{tid:int}/season/{n}")
async def tmdb_season(tid: int, n: int):
    return {"name": f"Season {n}", "episodes": [{"episode_number": i, "name": f"Episode {i}", "overview": "", "still_path": None} for i in range(1, 11)]}


@app.get("/3/search/multi")
async def tmdb_search(query: str = ""):
    return {"results": [{**MATRIX, "media_type": "movie"}, {**SHOW, "media_type": "tv"}, {"id": 1, "name": "Someone", "media_type": "person"}]}


@app.get("/3/trending/{mt}/{window}")
async def tmdb_trending(mt: str, window: str):
    return {"results": [{**MATRIX, "media_type": "movie"}, {**SHOW, "media_type": "tv"}]}


@app.get("/3/{section}/{name}")
async def tmdb_lists(section: str, name: str):
    return {"results": [{**MATRIX, "media_type": "movie"}, {**SHOW, "media_type": "tv"}], "page": 1, "total_pages": 1}


@app.get("/3/genre/{mt}/list")
async def tmdb_genres(mt: str):
    return {"genres": [{"id": 28, "name": "Action"}]}


@app.get("/3/discover/{mt}")
async def tmdb_discover(mt: str):
    return {"results": [MATRIX if mt == "movie" else SHOW], "page": 1, "total_pages": 3}
