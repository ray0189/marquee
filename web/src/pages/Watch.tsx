import { ArrowLeft, ListVideo, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { Player } from "../components/Player";
import { StreamList } from "../components/StreamList";
import { epLabel } from "../lib/format";
import { useStreams } from "../lib/useStreams";
import type { HistoryItem, MediaType, Meta, StreamItem } from "../types";
import { useBack } from "../lib/back";

export default function Watch() {
  const { type, id } = useParams();
  const mt = (type === "tv" ? "tv" : "movie") as MediaType;
  const tid = Number(id);
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const hash = sp.get("h");
  const season = sp.get("s") != null ? Number(sp.get("s")) : null;
  const episode = sp.get("e") != null ? Number(sp.get("e")) : null;

  const [meta, setMeta] = useState<Meta | null>(null);
  const [resume, setResume] = useState<number | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const streams = useStreams(mt, tid, season, episode, mt === "movie" || (season != null && episode != null));

  useEffect(() => {
    api<Meta>(`/api/meta/${mt}/${tid}`).then(setMeta).catch(() => nav("/", { replace: true }));
  }, [mt, tid, nav]);

  useEffect(() => {
    setResume(null);
    api<HistoryItem | null>(`/api/history/${mt}/${tid}`)
      .then((h) => setResume(h && (mt === "movie" || (h.season === season && h.episode === episode)) && h.duration > 0 && h.position / h.duration < 0.94 ? h.position : 0))
      .catch(() => setResume(0));
  }, [mt, tid, season, episode]);

  // No source chosen yet: take the best one once every indexer has answered. If one is slow, go with what's
  // in after 4 s rather than keep the viewer waiting; early results are often not the best ones.
  useEffect(() => {
    if (hash || !streams.items.length) return;
    const t = setTimeout(() => setSp((q) => (q.get("h") ? q : new URLSearchParams({ ...Object.fromEntries(q), h: streams.items[0].hash })), { replace: true }), streams.final ? 0 : 4000);
    return () => clearTimeout(t);
  }, [hash, streams.items, streams.final, setSp]);

  const found = hash ? streams.items.find((i) => i.hash === hash) : undefined;
  const [grace, setGrace] = useState(true);
  useEffect(() => {
    setGrace(true);
    const t = setTimeout(() => setGrace(false), 1500);
    return () => clearTimeout(t);
  }, [hash]);
  const waitForRelease = !!hash && !found && !streams.final && grace;

  const next = useMemo(() => {
    if (mt !== "tv" || !meta || season == null || episode == null) return null;
    const cur = meta.seasons.find((s) => s.number === season);
    const nxt = cur && episode < cur.episodes ? { season, episode: episode + 1 } : meta.seasons.some((s) => s.number === season + 1 && s.episodes > 0) ? { season: season + 1, episode: 1 } : null;
    // TMDB counts announced episodes too; never offer one that hasn't aired.
    const last = meta.last_aired;
    if (nxt && last && (nxt.season > last.season || (nxt.season === last.season && nxt.episode > last.episode))) return null;
    return nxt;
  }, [mt, meta, season, episode]);

  const goNext = useCallback(() => next && nav(`/watch/tv/${tid}?s=${next.season}&e=${next.episode}`, { replace: true }), [next, nav, tid]);
  const onFail = useCallback((m: string) => {
    setFailed(m);
    setDrawer(true);
  }, []);

  const pick = (it: StreamItem) => {
    setFailed(null);
    setDrawer(false);
    setSp((q) => new URLSearchParams({ ...Object.fromEntries(q), h: it.hash }), { replace: true });
  };

  if (mt === "tv" && (season == null || episode == null)) return <Navigate to={`/title/tv/${tid}`} replace />;

  const title = meta?.title ?? "";
  const back = useBack(`/title/${mt}/${tid}`);
  const sourcesBtn = (
    <button onClick={() => setDrawer((d) => !d)} className="flex h-9 items-center gap-1.5 rounded-full bg-white/10 px-3.5 text-sm font-medium text-bone ring-1 ring-white/10 backdrop-blur-md transition hover:bg-white/20">
      <ListVideo size={16} /> Sources
    </button>
  );
  return (
    <div className="fixed inset-0 overflow-hidden bg-black">
      <main className="h-full w-full">
        {hash && meta && resume !== null ? (
          <Player
            type={mt}
            id={tid}
            season={season}
            episode={episode}
            hash={hash}
            release={found?.release ?? null}
            waitForRelease={waitForRelease}
            title={title}
            poster={meta.poster}
            backdrop={meta.backdrop}
            runtime={mt === "movie" ? meta.runtime : null}
            resume={resume}
            next={next}
            onNext={goNext}
            onFail={onFail}
            onBack={back}
            actions={sourcesBtn}
          />
        ) : (
          <div className="relative flex h-full w-full items-center justify-center">
            <div className="safe-t absolute inset-x-0 top-0 flex items-center justify-between p-[clamp(10px,2vw,22px)]">
              <button aria-label="Back" onClick={back} className="grid size-10 place-items-center rounded-full text-bone hover:bg-white/10">
                <ArrowLeft size={22} />
              </button>
              {sourcesBtn}
            </div>
            <div className="text-center text-sm text-bone-dim">
              <div className="mx-auto mb-4 h-9 w-9 animate-spin rounded-full border-2 border-bone border-t-transparent" />
              {streams.error ?? (streams.final && !streams.items.length ? "No playable sources found." : "Finding the best source…")}
            </div>
          </div>
        )}

        <aside
          className={`safe-t absolute inset-y-0 right-0 z-50 sheet flex w-[min(460px,100%)] flex-col bg-ink-950/95 shadow-lift ring-1 ring-white/5 backdrop-blur-xl transition-transform duration-500 ease-out-expo ${drawer ? "translate-x-0" : "pointer-events-none translate-x-full"}`}
        >
          <div className="flex items-center justify-between px-5 pb-3 pt-5">
            <div className="min-w-0">
              <h2 className="text-base font-bold">Sources</h2>
              <p className="truncate text-xs text-bone-mute">{title}{mt === "tv" && ` · ${epLabel(season, episode)}`}</p>
            </div>
            <button aria-label="Close sources" onClick={() => setDrawer(false)} className="rounded-full p-2 text-bone-dim hover:bg-white/10 hover:text-bone">
              <X size={18} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-4 pb-8">
            {failed && <div className="mb-4 rounded-xl border border-ember/30 bg-ember/10 p-3 text-sm text-ember">{failed}</div>}
            <StreamList state={streams} onPick={pick} activeHash={hash} compact />
          </div>
        </aside>
      </main>
    </div>
  );
}
