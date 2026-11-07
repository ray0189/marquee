import { Info, Play, Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { img } from "../api";
import type { Card } from "../types";

export function Hero({ items }: { items: Card[] }) {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const touch = useRef<number | null>(null);
  useEffect(() => {
    if (paused || items.length < 2) return;
    const t = setInterval(() => setI((x) => (x + 1) % items.length), 8000);
    return () => clearInterval(t);
  }, [paused, items.length]);

  if (!items.length) return null;
  const cur = items[i];
  const go = (d: number) => setI((x) => (x + d + items.length) % items.length);
  return (
    <section
      className="relative isolate h-[74vh] min-h-[480px] w-full overflow-hidden bg-ink-900 md:h-[84vh]"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onTouchStart={(e) => (touch.current = e.touches[0].clientX)}
      onTouchEnd={(e) => {
        if (touch.current === null) return;
        const dx = e.changedTouches[0].clientX - touch.current;
        touch.current = null;
        if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
      }}
    >
      {items.map((it, idx) => Math.min(Math.abs(idx - i), items.length - Math.abs(idx - i)) <= 1 && (
        <img
          key={it.type + it.id}
          src={img(it.backdrop, "w1280")}
          srcSet={`${img(it.backdrop, "w780")} 780w, ${img(it.backdrop, "w1280")} 1280w`}
          sizes="100vw"
          decoding="async"
          alt=""
          onError={(e) => (e.currentTarget.style.display = "none")}
          className={`absolute inset-0 -z-10 h-full w-full object-cover object-[60%_20%] transition-opacity duration-1000 ${idx === i ? "opacity-100 animate-kenburns" : "opacity-0"}`}
        />
      ))}
      <div className="absolute inset-0 -z-10 bg-gradient-to-t from-ink-950 via-ink-950/20 to-ink-950/40" />
      <div className="absolute inset-0 -z-10 bg-gradient-to-r from-ink-950/80 via-transparent to-transparent" />

      <div key={cur.type + cur.id} className="absolute inset-x-0 bottom-[11%] mx-auto flex max-w-3xl animate-rise flex-col items-center px-6 text-center md:left-0 md:mx-0 md:items-start md:px-10 md:text-left">
        <div className="mb-3 flex items-center gap-2.5 text-[13px] font-medium text-bone/80">
          <span>{cur.type === "tv" ? "Series" : "Film"}</span>
          {cur.year && <span>· {cur.year}</span>}
          {cur.rating > 0 && (
            <span className="flex items-center gap-1">
              · <Star size={12} className="fill-bone text-bone" /> {cur.rating.toFixed(1)}
            </span>
          )}
        </div>
        <h1 className="font-display text-4xl font-extrabold leading-[1.02] tracking-tight drop-shadow-lg md:text-7xl">{cur.title}</h1>
        <p className="mt-3 line-clamp-3 max-w-xl text-sm leading-relaxed text-bone/75 md:mt-4 md:text-base">{cur.overview}</p>
        <div className="mt-5 flex items-center gap-3">
          <Link to={cur.type === "movie" ? `/watch/movie/${cur.id}` : `/title/tv/${cur.id}`} className="btn-primary !px-7 !py-3 text-[15px]">
            <Play size={18} className="fill-current" /> {cur.type === "movie" ? "Play" : "Watch"}
          </Link>
          <Link to={`/title/${cur.type}/${cur.id}`} className="btn-ghost !px-6 !py-3 text-[15px]">
            <Info size={18} /> Info
          </Link>
        </div>
      </div>

      {items.length > 1 && (
        <div className="absolute inset-x-0 bottom-5 flex justify-center gap-1.5 md:bottom-8 md:left-auto md:right-10 md:justify-end">
          {items.map((it, idx) => (
            <button key={it.type + it.id} aria-label={`Show ${it.title}`} onClick={() => setI(idx)} className="group py-2">
              <span className={`block h-1.5 rounded-full transition-all duration-500 ${idx === i ? "w-7 bg-white" : "w-1.5 bg-white/30 group-hover:bg-white/60"}`} />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
