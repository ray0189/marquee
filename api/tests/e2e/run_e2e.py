"""End-to-end check of the real API against the mock services.

    python tests/e2e/run_e2e.py        (needs a local redis on :6379; starts everything else itself)
"""

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]
API, MOCK = "http://127.0.0.1:8100", "http://127.0.0.1:9100"
IP = "203.0.113.9"
ADMIN = {"X-Admin-Token": "adm-token-123456"}
H_A, H_B, H_C, H_D, H_LIB, H_PACK = "a" * 40, "b" * 40, "c" * 40, "d" * 40, "1" * 40, "9" * 40

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, bool(ok), detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"   [{detail}]" if detail and not ok else ""))


def sse(client: httpx.Client, url: str, **kw) -> tuple[list[dict], float, float]:
    events, first, t0 = [], 0.0, time.monotonic()
    with client.stream("GET", url, **kw) as r:
        assert r.status_code == 200, r.read()
        for line in r.iter_lines():
            if line.startswith("data: "):
                if not events:
                    first = time.monotonic() - t0
                events.append(json.loads(line[6:]))
    return events, first, time.monotonic() - t0


def final_items(events):
    return next(e for e in reversed(events) if e["type"] == "streams" and e["final"])


def main() -> int:
    env = {
        **os.environ,
        "SESSION_SECRET": "e2e-secret-e2e-secret-e2e-1234", "DATABASE_URL": f"sqlite+aiosqlite:///{ROOT}/e2e.db",
        "REDIS_URL": "redis://localhost:6379/14", "MEILI_URL": "http://127.0.0.1:1",
        "TORBOX_BASE_URL": f"{MOCK}/v1/api", "TMDB_BASE_URL": f"{MOCK}/3", "INDEXER_URLS": MOCK,
        "TORBOX_API_KEY": "mock-key", "TMDB_API_KEY": "tmdb-mock", "ADMIN_TOKEN": "adm-token-123456",
        "PUBLIC_WATCH_URL": API,
    }
    (ROOT / "e2e.db").unlink(missing_ok=True)
    subprocess.run(["redis-cli", "-n", "14", "flushdb"], check=True, capture_output=True)
    procs = [
        subprocess.Popen([sys.executable, "-m", "uvicorn", "tests.e2e.mock_services:app", "--port", "9100", "--log-level", "warning"], cwd=ROOT, env=env),
        subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--port", "8100", "--log-level", "warning"], cwd=ROOT, env=env),
    ]
    try:
        for url in (MOCK + "/__stats", API + "/api/health"):
            for _ in range(60):
                try:
                    if httpx.get(url, timeout=1).status_code == 200:
                        break
                except Exception:
                    time.sleep(0.25)
            else:
                print("service did not start:", url)
                return 2
        run()
    finally:
        for p in procs:
            p.send_signal(signal.SIGTERM)
        (ROOT / "e2e.db").unlink(missing_ok=True)
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    return 1 if failed else 0


def run() -> None:
    stat = lambda: httpx.get(MOCK + "/__stats").json()  # noqa: E731
    c = httpx.Client(base_url=API, headers={"X-Real-IP": IP}, timeout=20)  # X-Real-IP: what Caddy sends after resolving the visitor IP

    print("access control")
    check("watch route without cookie -> 401", c.get("/api/home").status_code == 401)
    check("admin without token -> 401", c.get("/api/admin/status").status_code == 401)
    check("admin with wrong token -> 401", c.get("/api/admin/status", headers={"X-Admin-Token": "nope"}).status_code == 401)
    check("robots header present", "noindex" in c.get("/api/health").headers.get("x-robots-tag", ""))

    r = c.post("/api/admin/links", json={"label": "Sami"}, headers=ADMIN)
    link = r.json()
    token = link["url"].rsplit("/j/", 1)[-1]
    check("admin creates link, URL returned once", r.status_code == 200 and "/j/" in link["url"])
    check("link list can show the URL again", token in c.get("/api/admin/links", headers=ADMIN).text)
    check("bad token rejected", c.post("/api/join", json={"token": "x" * 43}).status_code == 403)
    j = c.post("/api/join", json={"token": token})
    check("join sets httpOnly cookie", j.status_code == 200 and "httponly" in j.headers.get("set-cookie", "").lower())
    check("/me returns label", c.get("/api/me").json() == {"label": "Sami"})
    sess = j.json().get("session", "")
    nc = httpx.Client(base_url=API, headers={"X-Real-IP": "198.51.100.7"}, timeout=20)  # a second device with no cookie jar
    check("join returns a session for cookie-less devices", len(sess) > 20)
    check("session header works without a cookie", nc.get("/api/me", headers={"X-MQ-Session": sess}).json() == {"label": "Sami"})
    check("long-lived session is refused in a URL", nc.get("/api/me", params={"mq_s": sess}).status_code == 401)
    ut = nc.get("/api/url-token", headers={"X-MQ-Session": sess}).json()["token"]
    check("short-lived URL token works (EventSource/<track>)", nc.get("/api/me", params={"mq_t": ut}).status_code == 200)
    check("URL token is not the session", ut != sess)
    check("garbage session rejected", nc.get("/api/me", headers={"X-MQ-Session": "nope"}).status_code == 401)
    check("media proxy needs a valid signed handle, not a cookie", nc.get("/api/media/forged").status_code == 404)
    check("token not stored in plaintext in db", token.encode() not in (ROOT / "e2e.db").read_bytes())

    print("browse / meta / search")
    home = c.get("/api/home").json()
    seen = [(i["type"], i["id"]) for r in home["rows"] for i in r["items"]]
    check("home has rows and hero", len(home["rows"]) >= 1 and len(home["hero"]) >= 1)
    check("home never repeats a title across rows", len(seen) == len(set(seen)))
    br = c.get("/api/browse", params={"type": "movie", "genre": 28, "decade": 1990, "rating": 7, "provider": 8, "lang": "en", "sort": "rated"})
    check("browse accepts combined filters", br.status_code == 200 and len(br.json()["items"]) >= 1)
    check("trending browse works", c.get("/api/browse", params={"type": "tv", "sort": "trending"}).status_code == 200)
    check("search falls back to TMDB with Meili down", any(i["title"] == "The Matrix" for i in c.get("/api/search", params={"q": "matrx"}).json()["items"]))
    check("search drops 'person' results", all(i["type"] in ("movie", "tv") for i in c.get("/api/search", params={"q": "x"}).json()["items"]))
    m = c.get("/api/meta/movie/603").json()
    check("meta has imdb id + cast", m["imdb_id"] == "tt0133093" and m["cast"][0]["name"] == "Keanu Reeves")
    tv = c.get("/api/meta/tv/1399").json()
    check("tv meta: imdb id, specials hidden", tv["imdb_id"] == "tt0944947" and [s["number"] for s in tv["seasons"]] == [1])
    check("season episodes", len(c.get("/api/meta/tv/1399/season/1").json()["episodes"]) == 10)

    print("resolver (movie)")
    before = stat()
    events, ttfe, total = sse(c, "/api/streams/movie/603")
    fin = final_items(events)
    hashes = [i["hash"] for i in fin["items"]]
    check("CAM release blocked", H_D not in hashes)
    check("uncached hidden and counted", H_C not in hashes and fin["hidden"] == 1, str(fin["hidden"]))
    check("REMUX 2160p ranks above 1080p WEB-DL", hashes.index(H_B) < hashes.index(H_A), str(hashes))
    check("SSE: indexer event then streams", [e["type"] for e in events][:2] == ["start", "streams"] or "indexer" in [e["type"] for e in events])
    mid = stat()
    check("checkcached batched (1 call for all hashes)", mid["checkcached"] - before["checkcached"] == 1, str(mid["checkcached"] - before["checkcached"]))
    events2, _, _ = sse(c, "/api/streams/movie/603")
    after = stat()
    check("second resolve served from cache, zero TorBox calls", final_items(events2).get("from_cache") and after["checkcached"] == mid["checkcached"])
    print(f"      first event {ttfe*1000:.0f} ms, total {total*1000:.0f} ms")

    print("library index + owned")
    sy = c.post("/api/admin/library/sync", headers=ADMIN).json()
    check("library sync indexes the mock library", sy.get("items") == 1, str(sy))
    from_redis = subprocess.run(["redis-cli", "-n", "14", "flushdb"], capture_output=True)
    c.post("/api/admin/library/sync", headers=ADMIN)  # restore index after the flush
    events3, _, _ = sse(c, "/api/streams/movie/603")
    top = final_items(events3)["items"][0]
    check("owned library release ranks first and is flagged", top["hash"] == H_LIB and top["owned"], f"{top['hash'][:4]} owned={top['owned']}")
    time.sleep(0.8)
    check("prewarm requested a link with the viewer's IP", stat()["last_requestdl"] and stat()["last_requestdl"].get("user_ip") == IP, str(stat()["last_requestdl"]))

    print("playback")
    p = c.post("/api/play", json={"media_type": "movie", "tmdb_id": 603, "hash": H_LIB, "mode": "direct"})
    media_proxy = p.json().get("proxy", "")
    pj = p.json()
    check("direct play returns a CDN url (no api key in it)", p.status_code == 200 and pj["url"].startswith("https://cdn.mock.invalid/dl/") and "mock-key" not in p.text, p.text[:200])
    check("mkv labelled video/mp4 for Chromium", pj["mime"] == "video/mp4")
    check("hints parsed from file name", pj["hints"]["container"] == "mkv" and pj["hints"]["codec"] == "avc")
    h = c.post("/api/play", json={"media_type": "movie", "tmdb_id": 603, "hash": H_B, "mode": "hls", "audio_index": 1}).json()
    check("hls play returns manifest + audio tracks", h["url"].endswith("playlist.m3u8") and "a1" in h["url"] and len(h["audios"]) == 2, str(h)[:200])
    check("uncached source -> 409 NOT_CACHED", c.post("/api/play", json={"media_type": "movie", "tmdb_id": 603, "hash": H_C}).json()["detail"]["code"] == "NOT_CACHED")
    check("bad hash rejected by validation", c.post("/api/play", json={"media_type": "movie", "tmdb_id": 603, "hash": "zz"}).status_code == 422)

    print("resolver + play (season pack)")
    ev, _, _ = sse(c, "/api/streams/tv/1399", params={"season": 1, "episode": 5})
    check("tv pack listed", any(i["hash"] == H_PACK for i in final_items(ev)["items"]))
    check("tv without episode -> 422", c.get("/api/streams/tv/1399").status_code == 422)
    c0 = stat()["createtorrent"]
    pk = c.post("/api/play", json={"media_type": "tv", "tmdb_id": 1399, "hash": H_PACK, "season": 1, "episode": 5}).json()
    check("pack added with multipart/form-data", stat()["createtorrent"] == c0 + 1 and "multipart/form-data" in (stat()["create_content_type"] or ""), str(stat()["create_content_type"]))
    check("picks S01E05, not the sample or E1/E10", pk.get("file", {}).get("name") == "Sample.Show.S01E05.1080p.WEB-DL.mkv", str(pk)[:300])
    pk10 = c.post("/api/play", json={"media_type": "tv", "tmdb_id": 1399, "hash": H_PACK, "season": 1, "episode": 10}).json()
    check("E10 resolves to E10", pk10.get("file", {}).get("name", "").endswith("S01E10.1080p.WEB-DL.mkv"), str(pk10)[:300])
    c1 = stat()["createtorrent"]
    check("pack not re-added on second play", c1 == c0 + 1)
    miss = c.post("/api/play", json={"media_type": "tv", "tmdb_id": 1399, "hash": H_PACK, "season": 1, "episode": 99})
    check("missing episode -> FILE_NOT_FOUND, never a wrong file", miss.status_code == 404 and miss.json()["detail"]["code"] == "FILE_NOT_FOUND", miss.text[:150])

    print("subtitles + history")
    check("vtt proxy refuses non-allowlisted host", c.get("/api/subs/vtt", params={"u": "https://evil.example/a.srt"}).status_code == 400)
    check("vtt proxy refuses http + internal addresses", c.get("/api/subs/vtt", params={"u": "http://127.0.0.1:9100/x"}).status_code == 400)
    body = {"media_type": "tv", "tmdb_id": 1399, "season": 1, "episode": 5, "position": 600, "duration": 3300, "title": "Sample Show", "poster": "/p2.jpg", "backdrop": "/b2.jpg"}
    check("save history", c.put("/api/history", json=body).status_code == 200)
    cw = c.get("/api/history").json()
    check("continue-watching lists it", cw and cw[0]["id"] == 1399 and cw[0]["episode"] == 5)
    c.put("/api/history", json={**body, "position": 3250})
    nxt = c.get("/api/history").json()
    check("finished episode becomes 'up next' for the following one", nxt and nxt[0]["episode"] == 6 and nxt[0]["position"] == 0, str(nxt))
    c.put("/api/history", json={**body, "episode": 10, "position": 3250})
    check("finished final episode drops out of continue-watching", c.get("/api/history").json() == [])

    print("admin")
    st = c.get("/api/admin/status", headers=ADMIN).json()
    check("status: plan, limits and library visible", st["torbox"]["ok"] and st["limits"]["minute"]["used"] > 0 and st["library"]["items"] >= 1)
    check("status never exposes the api key or full email", "mock-key" not in json.dumps(st) and "owner@example.com" not in json.dumps(st))
    bad = c.put("/api/admin/settings/torbox", json={"key": "definitely-wrong-key"}, headers=ADMIN)
    check("wrong TorBox key rejected before saving", bad.status_code == 422, bad.text[:120])
    good = c.put("/api/admin/settings/torbox", json={"key": "mock-key"}, headers=ADMIN)
    check("valid TorBox key accepted + stored encrypted", good.status_code == 200 and b"mock-key" not in (ROOT / "e2e.db").read_bytes())
    check("quality settings round-trip", c.put("/api/admin/settings/quality", json={**c.get("/api/admin/settings/quality", headers=ADMIN).json(), "min_resolution": 1080}, headers=ADMIN).status_code == 200)

    print("revocation")
    rv = c.delete(f"/api/admin/links/{link['id']}", headers=ADMIN)
    check("revoke link", rv.status_code == 200 and rv.json()["revoked_at"])
    check("revoked cookie locked out immediately", c.get("/api/home").status_code == 401)
    check("revoked link's stream handle stops working", c.get(media_proxy, headers={"Range": "bytes=0-1"}).status_code == 401)


if __name__ == "__main__":
    sys.exit(main())
