import { SlidersHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { PosterCard, PosterSkeleton } from "../components/PosterCard";
import type { Card, MediaType } from "../types";

const SORTS = [
  { id: "popular", label: "Popular" },
  { id: "trending", label: "Trending" },
  { id: "rated", label: "Top rated" },
  { id: "new", label: "Newest" },
] as const;

const DECADES = [2020, 2010, 2000, 1990, 1980, 1970, 1960];
const RATINGS = [6, 7, 8];
const SERVICES = [
  { id: 8, name: "Netflix" },
  { id: 9, name: "Prime Video" },
  { id: 337, name: "Disney+" },
  { id: 350, name: "Apple TV+" },
  { id: 531, name: "Paramount+" },
];
const LANGS = [
  { id: "en", name: "English" },
  { id: "ja", name: "Japanese" },
  { id: "ko", name: "Korean" },
  { id: "hi", name: "Hindi" },
  { id: "fr", name: "French" },
  { id: "es", name: "Spanish" },
  { id: "de", name: "German" },
  { id: "it", name: "Italian" },
];

const chip = (on: boolean) => `shrink-0 rounded-full px-4 py-2 text-sm font-semibold transition active:scale-95 ${on ? "bg-white text-black" : "bg-white/[0.08] text-bone-dim hover:bg-white/15 hover:text-bone"}`;
const select = "rounded-full border border-white/10 bg-ink-800 px-3.5 py-2 text-sm font-medium text-bone outline-none focus:border-white/40";

export default function Browse() {
  const { type } = useParams();
  const mt = (type === "tv" ? "tv" : "movie") as MediaType;
  const [sp, setSp] = useSearchParams();
  const [genres, setGenres] = useState<{ id: number; name: string }[]>([]);
  const [items, setItems] = useState<Card[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);

  const sort = sp.get("sort") ?? "popular";
  const genre = sp.get("genre");
  const decade = sp.get("decade");
  const rating = sp.get("rating");
  const provider = sp.get("provider");
  const lang = sp.get("lang");
  const filterKey = `${mt}|${sort}|${genre}|${decade}|${rating}|${provider}|${lang}`;
  const active = [decade, rating, provider, lang].filter(Boolean).length;

  const set = useCallback(
    (k: string, v: string | null) =>
      setSp((q) => {
        const n = new URLSearchParams(q);
        if (v === null || v === "") n.delete(k);
        else n.set(k, v);
        return n;
      }, { replace: true }),
    [setSp],
  );

  useEffect(() => {
    api<{ id: number; name: string }[]>(`/api/genres/${mt}`).then(setGenres).catch(() => setGenres([]));
  }, [mt]);

  // Any filter change starts the list over.
  useEffect(() => {
    setItems([]);
    setPage(1);
    setPages(1);
    window.scrollTo({ top: 0 });
  }, [filterKey]);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    const qs = new URLSearchParams({ type: mt, sort, page: String(page) });
    if (genre) qs.set("genre", genre);
    if (decade) qs.set("decade", decade);
    if (rating) qs.set("rating", rating);
    if (provider) qs.set("provider", provider);
    if (lang) qs.set("lang", lang);
    api<{ items: Card[]; total_pages: number }>(`/api/browse?${qs}`, { signal: ctrl.signal })
      .then((r) => {
        const fresh = r.items.filter((n) => n.poster);
        setItems((prev) => (page === 1 ? fresh : [...prev, ...fresh.filter((n) => !prev.some((p) => p.id === n.id))]));
        setPages(r.total_pages);
        setLoading(false);
      })
      .catch((e) => e?.name !== "AbortError" && setLoading(false));
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, page]);

  // Endless scroll: load the next page when the end of the grid comes into view.
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => es[0].isIntersecting && !loading && page < pages && setPage((p) => p + 1), { rootMargin: "900px" });
    io.observe(el);
    return () => io.disconnect();
  }, [loading, page, pages, items.length]);

  const clear = () => setSp((q) => new URLSearchParams({ ...(q.get("sort") ? { sort: q.get("sort")! } : {}), ...(q.get("genre") ? { genre: q.get("genre")! } : {}) }), { replace: true });

  return (
    <div className="pb-28 pt-24 md:pb-24 md:pt-28">
      <div className="px-5 md:px-10">
        <div className="flex items-end justify-between gap-4">
          <h1 className="font-display text-4xl font-extrabold tracking-tight md:text-5xl">{mt === "tv" ? "Series" : "Films"}</h1>
          <button onClick={() => setOpen((v) => !v)} className={`btn-ghost !py-2 ${open || active ? "!bg-white !text-black" : ""}`}>
            <SlidersHorizontal size={16} /> Filters{active ? ` · ${active}` : ""}
          </button>
        </div>

        <div className="no-scrollbar mt-5 flex gap-2 overflow-x-auto pb-1">
          {SORTS.map((s) => (
            <button key={s.id} onClick={() => set("sort", s.id === "popular" ? null : s.id)} className={chip(sort === s.id)}>
              {s.label}
            </button>
          ))}
        </div>

        {open && (
          <div className="mt-3 flex flex-wrap items-center gap-2.5 rounded-2xl bg-white/[0.04] p-3 animate-rise">
            <select aria-label="Decade" className={select} value={decade ?? ""} onChange={(e) => set("decade", e.target.value || null)}>
              <option value="">Any year</option>
              {DECADES.map((d) => (
                <option key={d} value={d}>
                  {d}s
                </option>
              ))}
            </select>
            <select aria-label="Minimum rating" className={select} value={rating ?? ""} onChange={(e) => set("rating", e.target.value || null)}>
              <option value="">Any rating</option>
              {RATINGS.map((r) => (
                <option key={r} value={r}>
                  {r}+ stars
                </option>
              ))}
            </select>
            <select aria-label="Streaming service" className={select} value={provider ?? ""} onChange={(e) => set("provider", e.target.value || null)}>
              <option value="">Any service</option>
              {SERVICES.map((s) => (
                <option key={s.id} value={s.id}>
                  On {s.name}
                </option>
              ))}
            </select>
            <select aria-label="Language" className={select} value={lang ?? ""} onChange={(e) => set("lang", e.target.value || null)}>
              <option value="">Any language</option>
              {LANGS.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
            {active > 0 && (
              <button onClick={clear} className="btn-quiet !py-2 text-sm">
                <X size={14} /> Clear
              </button>
            )}
          </div>
        )}

        <div className="no-scrollbar mt-3 flex gap-2 overflow-x-auto pb-1">
          <button onClick={() => set("genre", null)} className={chip(!genre)}>
            All genres
          </button>
          {genres.map((g) => (
            <button key={g.id} onClick={() => set("genre", String(g.id))} className={chip(genre === String(g.id))}>
              {g.name}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6 grid grid-cols-3 gap-x-3 gap-y-5 px-5 sm:grid-cols-4 md:grid-cols-5 md:gap-x-4 md:px-10 lg:grid-cols-6 xl:grid-cols-8">
        {items.map((it) => (
          <PosterCard key={it.type + it.id} item={it} />
        ))}
        {loading && Array.from({ length: 12 }, (_, i) => <PosterSkeleton key={i} />)}
      </div>

      {!loading && items.length === 0 && (
        <div className="mx-auto mt-16 max-w-sm px-6 text-center">
          <p className="text-lg font-bold">Nothing matches</p>
          <p className="mt-1 text-sm text-bone-dim">Try fewer filters, or a different service or decade.</p>
          {active > 0 && (
            <button onClick={clear} className="btn-ghost mt-4">
              Clear filters
            </button>
          )}
        </div>
      )}
      <div ref={sentinel} className="h-10" />
    </div>
  );
}
