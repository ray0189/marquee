import { Clock, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { api } from "../api";
import { addRecentSearch, clearRecentSearches, recentSearches, removeRecentSearch } from "../lib/recent";
import type { Card } from "../types";
import { PosterCard } from "./PosterCard";

export function SearchOverlay({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Card[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [recent, setRecent] = useState<string[]>(recentSearches);
  const remember = () => setRecent(addRecentSearch(q));
  const input = useRef<HTMLInputElement>(null);
  const loc = useLocation();
  const first = useRef(true);

  useEffect(() => {
    input.current?.focus();
    document.body.style.overflow = "hidden";
    return () => void (document.body.style.overflow = "");
  }, []);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    onClose(); // navigating to a title closes the overlay
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.pathname]);

  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setItems([]);
      return;
    }
    setBusy(true);
    setFailed(false);
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const r = await api<{ items: Card[] }>(`/api/search?q=${encodeURIComponent(term)}`, { signal: ctrl.signal });
        setItems(r.items);
        setBusy(false);
      } catch {
        if (ctrl.signal.aborted) return; // a newer keystroke took over; it owns the busy flag now
        setFailed(true); // a failure must not read as "Nothing found"
        setBusy(false);
      }
    }, 120);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, retry]);

  return (
    <div className="fixed inset-0 z-[70] sheet animate-fade bg-ink-950/90 backdrop-blur-2xl" onClick={onClose} role="dialog" aria-label="Search">
      <div className="mx-auto flex h-full max-w-6xl flex-col px-5 pt-6 md:px-10 md:pt-10" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-4 border-b border-white/10 pb-4">
          <Search className="text-bone-mute" size={26} />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "Enter") {
                remember();
                input.current?.blur(); // closes the phone keyboard so the results are visible
              }
            }}
            placeholder="Search films and series" enterKeyHint="search"
            className="min-w-0 flex-1 bg-transparent text-2xl font-bold tracking-tight outline-none placeholder:text-bone-mute md:text-5xl"
            autoComplete="off"
            spellCheck={false}
          />
          <button onClick={onClose} className="btn-quiet !p-2" aria-label="Close search">
            <X size={22} />
          </button>
        </div>
        <div className="no-scrollbar flex-1 overflow-y-auto py-8">
          {!q.trim() && !recent.length && <p className="text-bone-mute">Start typing. Typos are fine.</p>}
          {!q.trim() && recent.length > 0 && (
            <section className="animate-fade">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-bone-mute">Recent searches</h2>
                <button className="text-sm font-medium text-bone-dim transition hover:text-bone" onClick={() => setRecent(clearRecentSearches())}>
                  Clear
                </button>
              </div>
              <ul className="divide-y divide-white/[0.06]">
                {recent.map((term) => (
                  <li key={term} className="flex items-center gap-3">
                    <button
                      className="flex min-w-0 flex-1 items-center gap-3 py-3 text-left text-lg text-bone transition hover:text-white active:opacity-70"
                      onClick={() => {
                        setQ(term);
                        input.current?.focus();
                      }}
                    >
                      <Clock size={17} className="shrink-0 text-bone-mute" />
                      <span className="truncate">{term}</span>
                    </button>
                    <button
                      aria-label={`Remove ${term} from recent searches`}
                      className="grid size-9 shrink-0 place-items-center rounded-full text-bone-mute transition hover:bg-white/10 hover:text-bone"
                      onClick={() => setRecent(removeRecentSearch(term))}
                    >
                      <X size={16} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {q.trim() && failed && !busy && (
            <p className="text-bone-mute">
              Search isn't responding right now.{" "}
              <button className="font-medium text-bone underline underline-offset-4" onClick={() => setRetry((n) => n + 1)}>
                Try again
              </button>
            </p>
          )}
          {q.trim() && !failed && !items.length && !busy && <p className="text-bone-mute">Nothing found for “{q}”.</p>}
          {/* Opening a result saves the search that found it */}
          <div className="grid grid-cols-3 gap-3 pb-24 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6" onClickCapture={remember}>
            {items.map((it) => (
              <PosterCard key={it.type + it.id} item={it} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
