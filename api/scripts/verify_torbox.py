"""Check Marquee's TorBox assumptions against the REAL API with your key.

    docker compose run --rm api python -m scripts.verify_torbox          # uses TORBOX_API_KEY from .env
    docker compose run --rm api python -m scripts.verify_torbox <40-hex hash that you know is cached>

Why this exists: Marquee's TorBox client was written from documented and previously observed response shapes
(and tested against a mock), not against your account. Run this once. It prints, per endpoint, what came back
and whether it matches what the client expects. It only reads, except it will `createtorrent` the optional
hash you pass (a cached hash is added instantly). The key is never printed.
"""

import asyncio
import sys

from app import settings_store as store, torbox
from app.db import init_db
from app.torbox import _call


def line(ok: bool | None, name: str, detail: str = "") -> None:
    tag = {True: "OK  ", False: "FAIL", None: "NOTE"}[ok]
    print(f"[{tag}] {name}" + (f"  {detail}" if detail else ""))


def shape(x) -> str:
    if isinstance(x, dict):
        return "dict{" + ", ".join(sorted(map(str, x.keys()))[:14]) + "}"
    if isinstance(x, list):
        return f"list[{len(x)}]" + (f" of {shape(x[0])}" if x else "")
    return type(x).__name__


async def main() -> int:
    await init_db()
    key = await store.torbox_key()
    if not key:
        print("No TorBox key. Set TORBOX_API_KEY in .env first.")
        return 2
    bad = 0

    try:
        me = await torbox.user_me()
        line(True, "user/me", f"plan={me.get('plan')} fields={shape(me)}")
    except Exception as e:  # noqa: BLE001
        line(False, "user/me", str(e))
        return 1

    try:
        page = await torbox.mylist_page(0, 5)
        line(True, "torrents/mylist", shape(page))
        sample = page[0] if page else None
        if sample:
            need = {"id", "hash", "name", "files"}
            miss = need - set(sample)
            line(not miss, "  mylist item has id/hash/name/files", f"missing={sorted(miss)}" if miss else shape(sample.get("files")))
            bad += bool(miss)
            if sample.get("files"):
                fneed = {"id", "name", "size"}
                fm = fneed - set(sample["files"][0])
                line(not fm, "  file has id/name/size", f"missing={sorted(fm)}" if fm else "")
                bad += bool(fm)
        one = await torbox.mylist_one(sample["id"]) if sample else None
        if sample:
            line(isinstance(one, dict), "  mylist?id= returns a single object", shape(one))
    except Exception as e:  # noqa: BLE001
        line(False, "torrents/mylist", str(e))
        bad += 1
        sample = None

    probe = [sample["hash"]] if sample else []
    arg = sys.argv[1].lower() if len(sys.argv) > 1 else None
    if arg:
        probe.append(arg)
    probe.append("0" * 40)  # certainly not cached
    try:
        raw = await _call("POST", "/torrents/checkcached", params={"format": "list"}, json_body={"hashes": probe})
        got = torbox._present(raw)
        line(True, "torrents/checkcached (POST, format=list)", f"raw={shape(raw)}")
        line("0" * 40 not in got, "  an uncached hash is absent (presence = cached)")
        if sample:
            line(sample["hash"].lower() in got, "  a hash from your library reports cached")
    except Exception as e:  # noqa: BLE001
        line(False, "torrents/checkcached", str(e))
        bad += 1

    if sample and sample.get("files"):
        vid = next((f for f in sample["files"] if f.get("name", "").lower().endswith((".mkv", ".mp4"))), sample["files"][0])
        try:
            url = await torbox.request_dl_raw(sample["id"], vid["id"], None)
            print("   download link embeds the account key:", await torbox.embeds_key(url), "(Marquee then streams it through the server)")
            line(True, "torrents/requestdl (redirect=false)", f"returns {url.split('?')[0][:60]}…")
            line(key not in url, "  returned link does NOT contain your API key")
        except Exception as e:  # noqa: BLE001
            line(False, "torrents/requestdl", str(e))
            bad += 1
        try:
            s = await torbox.create_stream(sample["id"], vid["id"])
            n = torbox.normalize_stream(s)
            line(bool(n["hls_url"]), "stream/createstream", f"keys={shape(s)}")
            line(None, "  needs_transcoding", str(n["needs_transcoding"]))
            line(None, "  audio tracks / subtitle tracks", f"{len(n['audios'])} / {len(n['subtitles'])}")
            line(n["needs_transcoding"] is not None, "  response has needs_transcoding + metadata",
                 "if this is FAIL, adjust normalize_stream() in app/torbox.py to the keys shown above")
        except Exception as e:  # noqa: BLE001
            line(False, "stream/createstream", str(e))
            bad += 1

    if arg:
        try:
            made = await torbox.create_torrent(arg)
            line(bool(made.get("torrent_id")), "torrents/createtorrent (multipart)", shape(made))
        except Exception as e:  # noqa: BLE001
            line(False, "torrents/createtorrent", str(e))
            bad += 1
    else:
        line(None, "torrents/createtorrent", "skipped (pass a cached 40-hex hash to test adding)")

    print("\nAll good." if not bad else f"\n{bad} problem(s). Paste this output to me and I'll adjust the client.")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
