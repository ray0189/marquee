import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { ApiError, api, img } from "../api";
import { Hero } from "../components/Hero";
import { PosterCard, PosterSkeleton } from "../components/PosterCard";
import { Row } from "../components/Row";
import { epLabel, fmtTime } from "../lib/format";
import type { Card, HistoryItem } from "../types";
import { fadeIn } from "../lib/fade";

interface HomeData {
  hero: Card[];
  rows: { title: string; more?: string | null; items: Card[] }[];
}

function ContinueCard({ h }: { h: HistoryItem }) {
  const pct = h.duration > 0 ? Math.min(100, (h.position / h.duration) * 100) : 0;
  const href = h.type === "tv" ? `/watch/tv/${h.id}?s=${h.season}&e=${h.episode}` : `/watch/movie/${h.id}`;
  return (
    <Link to={href} className="group block w-64 shrink-0 snap-start md:w-80">
      <div className="relative aspect-video overflow-hidden rounded-2xl bg-ink-800 ring-1 ring-white/[0.07] transition duration-500 ease-out-expo group-hover:scale-[1.03] group-hover:shadow-glow group-active:scale-[.98]">
        <img data-fade onLoad={fadeIn} src={img(h.backdrop ?? h.poster, "w500")} alt="" loading="lazy" className="h-full w-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/10 to-transparent" />
        <span className="absolute left-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-white/90 text-black shadow-lift">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
        </span>
        <div className="absolute inset-x-3 bottom-3">
          <div className="truncate text-sm font-bold drop-shadow">{h.title}</div>
          <div className="text-xs text-bone/70">
            {h.type === "tv" ? `${h.duration === 0 ? "Up next · " : ""}${epLabel(h.season, h.episode)}` : `${fmtTime(h.position)} watched`}
          </div>
        </div>
        <div className="absolute inset-x-0 bottom-0 h-1 bg-white/20">
          <div className="h-full bg-white" style={{ width: `${pct}%` }} />
        </div>
      </div>
    </Link>
  );
}

export default function Home() {
  const [data, setData] = useState<HomeData | null>(null);
  const [cont, setCont] = useState<HistoryItem[]>([]);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    api<HomeData>("/api/home").then(setData).catch((e) => e instanceof ApiError && setError(e));
    api<HistoryItem[]>("/api/history").then(setCont).catch(() => undefined);
  }, []);

  if (error) {
    return (
      <div className="mx-auto max-w-lg px-6 pt-44 text-center">
        <h1 className="font-display text-3xl font-bold">Almost ready</h1>
        <p className="mt-3 text-bone-dim">{error.code === "NO_TMDB" ? "The catalogue needs a TMDB key. Whoever runs this can add one in Admin → Keys." : error.message}</p>
      </div>
    );
  }

  return (
    <div className="pb-28 md:pb-24">
      {data ? <Hero items={data.hero} /> : <div className="skeleton h-[74vh] min-h-[480px] w-full md:h-[84vh]" />}
      <div className="relative z-10 -mt-6 space-y-8 md:-mt-14 md:space-y-10">
        {cont.length > 0 && (
          <Row title="Continue watching">
            {cont.map((h) => (
              <ContinueCard key={h.type + h.id} h={h} />
            ))}
          </Row>
        )}
        {data
          ? data.rows.map((r) => (
              <Row key={r.title} title={r.title} more={r.more}>
                {r.items.map((it) => (
                  <PosterCard key={it.type + it.id} item={it} className="w-[118px] sm:w-36 md:w-44" />
                ))}
              </Row>
            ))
          : [0, 1, 2].map((n) => (
              <Row key={n} title="">
                {Array.from({ length: 9 }, (_, i) => (
                  <PosterSkeleton key={i} className="w-[118px] sm:w-36 md:w-44" />
                ))}
              </Row>
            ))}
      </div>
    </div>
  );
}
