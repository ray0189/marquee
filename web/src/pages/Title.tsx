import { Play, Star } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, img } from "../api";
import { PosterCard } from "../components/PosterCard";
import { Row } from "../components/Row";
import { StreamList } from "../components/StreamList";
import { fmtRuntime, fmtTime } from "../lib/format";
import { useStreams } from "../lib/useStreams";
import type { Episode, HistoryItem, MediaType, Meta, StreamItem } from "../types";
import { fadeIn } from "../lib/fade";

export default function Title() {
  const { type, id } = useParams();
  const mt = (type === "tv" ? "tv" : "movie") as MediaType;
  const tid = Number(id);
  const nav = useNavigate();

  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hist, setHist] = useState<HistoryItem | null>(null);
  const [seasonNo, setSeasonNo] = useState<number | null>(null);
  const [episodes, setEpisodes] = useState<Episode[] | null>(null);
  const [epNo, setEpNo] = useState<number | null>(null);

  useEffect(() => {
    setMeta(null);
    setError(null);
    setSeasonNo(null);
    setEpNo(null);
    window.scrollTo(0, 0);
    Promise.all([api<Meta>(`/api/meta/${mt}/${tid}`), api<HistoryItem | null>(`/api/history/${mt}/${tid}`).catch(() => null)])
      .then(([m, h]) => {
        setMeta(m);
        setHist(h);
        if (mt === "tv") {
          const s = h?.season ?? m.seasons[0]?.number ?? 1;
          setSeasonNo(s);
          setEpNo(h?.episode ?? 1);
        }
      })
      .catch((e) => setError(e.message ?? "Couldn't load this title."));
  }, [mt, tid]);

  useEffect(() => {
    if (mt !== "tv" || seasonNo == null) return;
    setEpisodes(null);
    api<{ episodes: Episode[] }>(`/api/meta/tv/${tid}/season/${seasonNo}`).then((r) => setEpisodes(r.episodes)).catch(() => setEpisodes([]));
  }, [mt, tid, seasonNo]);

  const streams = useStreams(mt, tid, seasonNo, epNo, !!meta && (mt === "movie" || (seasonNo != null && epNo != null)));

  const qs = (extra = "") => (mt === "tv" ? `?s=${seasonNo}&e=${epNo}${extra}` : extra ? `?${extra.slice(1)}` : "");
  const playHref = `/watch/${mt}/${tid}${qs()}`;
  const resumeable = hist && hist.duration > 0 && hist.position > 30 && hist.position / hist.duration < 0.94 && (mt === "movie" || (hist.season === seasonNo && hist.episode === epNo));
  const pick = (it: StreamItem) => nav(`/watch/${mt}/${tid}${qs(`&h=${it.hash}`)}`);
  const selectedEp = useMemo(() => episodes?.find((e) => e.number === epNo), [episodes, epNo]);

  if (error) return <div className="px-5 pt-40 text-center text-bone-dim md:px-10">{error}</div>;
  if (!meta) return <div className="skeleton h-[70vh] w-full" />;

  return (
    <div className="animate-fade">
      <section className="relative isolate min-h-[540px] overflow-hidden">
        <img data-fade onLoad={fadeIn} src={img(meta.backdrop, "w1280")} alt="" className="absolute inset-0 -z-10 h-full w-full object-cover object-top" />
        <div className="absolute inset-0 -z-10 bg-gradient-to-t from-ink-950 via-ink-950/60 to-ink-950/20" />
        <div className="absolute inset-0 -z-10 bg-gradient-to-r from-ink-950/90 via-ink-950/30 to-transparent" />
        <div className="mx-auto flex max-w-7xl flex-col gap-8 px-5 pb-8 pt-64 md:flex-row md:items-end md:px-10 md:pt-44">
          <img data-fade onLoad={fadeIn} src={img(meta.poster, "w500")} alt="" className="hidden w-52 shrink-0 rounded-2xl shadow-lift ring-1 ring-white/10 md:block lg:w-60" />
          <div className="max-w-3xl">
            <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-bone-dim">
              <span className="font-semibold text-bone">{mt === "tv" ? "Series" : "Film"}</span>
              {meta.year && <span>{meta.year}</span>}
              {meta.runtime && <span>{fmtRuntime(meta.runtime)}</span>}
              {meta.certification && <span className="chip">{meta.certification}</span>}
              {meta.rating > 0 && (
                <span className="flex items-center gap-1">
                  <Star size={13} className="fill-bone text-bone" /> {meta.rating.toFixed(1)}
                </span>
              )}
            </div>
            <h1 className="font-display text-4xl font-extrabold leading-[1.05] tracking-tight md:text-6xl">
              {meta.title}
            </h1>
            {meta.tagline && <p className="mt-3 text-base italic text-bone-dim">{meta.tagline}</p>}
            <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-bone/80">{meta.overview}</p>
            {meta.genres.length > 0 && <p className="mt-3 text-sm text-bone-mute">{meta.genres.join(" · ")}</p>}
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Link to={playHref} className="btn-primary !px-8 !py-3.5 text-base">
                <Play size={18} className="fill-current" />
                {resumeable ? `Resume ${fmtTime(hist!.position)}` : mt === "tv" ? `Play S${seasonNo} · E${epNo}` : "Play"}
              </Link>
              {resumeable && hist!.duration > 0 && (
                <div className="h-1 w-28 overflow-hidden rounded-full bg-white/15">
                  <div className="h-full bg-white" style={{ width: `${(hist!.position / hist!.duration) * 100}%` }} />
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-7xl space-y-12 px-5 pb-20 md:px-10">
        {mt === "tv" && meta.seasons.length > 0 && (
          <section>
            <div className="no-scrollbar mb-4 flex items-center gap-2 overflow-x-auto pb-1 md:flex-wrap">
              <h2 className="mr-3 w-full text-xl font-bold md:w-auto md:text-2xl">Episodes</h2>
              {meta.seasons.map((s) => (
                <button
                  key={s.number}
                  onClick={() => {
                    setSeasonNo(s.number);
                    setEpNo(1);
                  }}
                  className={`rounded-full px-4 py-2 text-sm font-semibold transition active:scale-95 ${seasonNo === s.number ? "bg-white text-black" : "bg-white/[0.08] text-bone-dim hover:bg-white/15 hover:text-bone"}`}
                >
                  {meta.seasons.length > 8 ? s.number : (s.name ?? `Season ${s.number}`)}
                </button>
              ))}
            </div>
            <div className="grid gap-2.5 lg:grid-cols-2">
              {(episodes ?? Array.from({ length: 6 }, () => null)).map((e, i) =>
                e ? (
                  <button
                    key={e.number}
                    onClick={() => setEpNo(e.number)}
                    className={`group flex gap-3 rounded-2xl p-2.5 text-left transition active:scale-[.99] ${epNo === e.number ? "bg-white/[0.12] ring-1 ring-white/30" : "bg-white/[0.04] hover:bg-white/[0.08]"}`}
                  >
                    <div className="relative aspect-video w-32 shrink-0 overflow-hidden rounded-xl bg-ink-700 sm:w-40">
                      {e.still && <img data-fade onLoad={fadeIn} src={img(e.still, "w342")} alt="" loading="lazy" className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />}
                      <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 text-[11px] font-bold">{e.number}</span>
                    </div>
                    <div className="min-w-0 py-0.5">
                      <div className="truncate text-sm font-semibold">{e.name}</div>
                      <div className="mt-0.5 text-[11px] text-bone-mute">{[e.air_date, e.runtime ? `${e.runtime}m` : ""].filter(Boolean).join(" · ")}</div>
                      <p className="mt-1 line-clamp-2 text-xs text-bone-dim">{e.overview}</p>
                    </div>
                  </button>
                ) : (
                  <div key={i} className="skeleton h-[92px] rounded-2xl" />
                ),
              )}
            </div>
          </section>
        )}

        <section>
          <h2 className="mb-1 text-xl font-bold md:text-2xl">Sources</h2>
          {mt === "tv" && <p className="mb-4 text-sm text-bone-mute">For S{seasonNo} · E{epNo}{selectedEp?.name ? ` — ${selectedEp.name}` : ""}</p>}
          <div className="mt-4 max-w-4xl">
            <StreamList state={streams} onPick={pick} />
          </div>
        </section>

        {meta.cast.length > 0 && (
          <section>
            <h2 className="mb-4 text-xl font-bold md:text-2xl">Cast</h2>
            <div className="no-scrollbar flex gap-5 overflow-x-auto pb-2">
              {meta.cast.map((c) => (
                <div key={c.name + c.character} className="w-24 shrink-0 text-center">
                  <div className="mx-auto h-20 w-20 overflow-hidden rounded-full bg-ink-700 ring-1 ring-white/10">{c.photo && <img data-fade onLoad={fadeIn} src={img(c.photo, "w185")} alt="" loading="lazy" className="h-full w-full object-cover" />}</div>
                  <div className="mt-2 truncate text-xs font-medium">{c.name}</div>
                  <div className="truncate text-[11px] text-bone-mute">{c.character}</div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      {meta.similar.length > 0 && (
        <div className="pb-28 md:pb-20">
          <Row title="More like this">
            {meta.similar.map((s) => (
              <PosterCard key={s.type + s.id} item={s} className="w-[118px] sm:w-36 md:w-44" />
            ))}
          </Row>
        </div>
      )}
    </div>
  );
}
