import { Play } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { img } from "../api";
import type { Card } from "../types";

export function PosterCard({ item, className = "" }: { item: Card; className?: string }) {
  const src = img(item.poster, "w342");
  const [bad, setBad] = useState(false);
  return (
    <Link to={`/title/${item.type}/${item.id}`} className={`group block shrink-0 snap-start outline-none ${className}`} title={item.title}>
      <div className="relative aspect-[2/3] overflow-hidden rounded-2xl bg-ink-800 ring-1 ring-white/[0.07] transition duration-300 group-hover:scale-[1.035] group-hover:shadow-glow group-focus-visible:shadow-glow group-active:scale-[.98]">
        {src && !bad ? (
          <img src={src} alt="" loading="lazy" decoding="async" onError={() => setBad(true)} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-ink-700 to-ink-900 p-3 text-center">
            <span className="text-sm font-bold leading-tight text-bone-dim">{item.title}</span>
            {item.year && <span className="text-xs text-bone-mute">{item.year}</span>}
          </div>
        )}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 transition duration-300 group-hover:opacity-100 group-focus-visible:opacity-100" />
        <span className="pointer-events-none absolute bottom-3 left-1/2 flex h-10 w-10 -translate-x-1/2 translate-y-2 items-center justify-center rounded-full bg-white text-black opacity-0 shadow-lift transition duration-300 group-hover:translate-y-0 group-hover:opacity-100">
          <Play size={16} className="fill-current" />
        </span>
        {item.rating > 0 && (
          <span className="absolute bottom-2 right-2 rounded-md bg-black/75 px-1.5 py-0.5 text-[10.5px] font-bold tabular-nums text-bone">{item.rating.toFixed(1)}</span>
        )}
      </div>
      <div className="mt-2 px-0.5">
        <div className="truncate text-[13px] font-semibold text-bone/95">{item.title}</div>
        <div className="text-xs text-bone-mute">{[item.year, item.type === "tv" ? "Series" : ""].filter(Boolean).join(" · ")}</div>
      </div>
    </Link>
  );
}

export function PosterSkeleton({ className = "" }: { className?: string }) {
  return (
    <div className={`shrink-0 ${className}`}>
      <div className="skeleton aspect-[2/3] rounded-2xl" />
      <div className="skeleton mt-2 h-3 w-3/4 rounded" />
    </div>
  );
}
