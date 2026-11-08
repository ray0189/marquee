import { ArrowLeft, Film, Home, Search, Tv } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useBack } from "../lib/back";
import { SearchOverlay } from "./SearchOverlay";
import { Wordmark } from "./Logo";
import { APP_NAME } from "../brand";

export function Nav({ label }: { label: string }) {
  const [solid, setSolid] = useState(false);
  const [search, setSearch] = useState(false);

  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable;
      if ((e.key === "/" && !typing) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")) {
        e.preventDefault();
        setSearch(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Back wherever there's somewhere to go back to: a title page, or a "See all" list (a browse page with
  // filters). Home and the Films/Series tabs are top-level, so they don't get one.
  const { pathname, search: query } = useLocation();
  const showBack = pathname.startsWith("/title/") || (pathname.startsWith("/browse/") && query.length > 1);
  const back = useBack("/");

  const link = ({ isActive }: { isActive: boolean }) => `rounded-full px-4 py-1.5 text-sm font-semibold transition ${isActive ? "bg-white text-black" : "text-bone-dim hover:text-bone"}`;
  const tab = ({ isActive }: { isActive: boolean }) => `flex flex-1 flex-col items-center gap-1 py-2 text-[10.5px] font-semibold transition ${isActive ? "text-bone" : "text-bone-mute"}`;

  return (
    <>
      <header className={`safe-t fixed inset-x-0 top-0 z-50 transition duration-300 ${solid ? "sheet bg-ink-950/80 backdrop-blur-xl" : "bg-gradient-to-b from-black/70 to-transparent"}`}>
        <div className="mx-auto flex items-center gap-6 px-5 md:px-10" style={{ height: "var(--nav-h)" }}>
          {showBack && (
            <button
              onClick={back}
              aria-label="Back"
              className="-ml-2 -mr-3 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-bone transition hover:bg-white/10 active:scale-90 animate-fade"
            >
              <ArrowLeft size={22} />
            </button>
          )}
          <Link to="/" aria-label={`${APP_NAME} home`}>
            <Wordmark />
          </Link>
          <nav className="mx-auto hidden items-center gap-1 rounded-full bg-white/[0.07] p-1 backdrop-blur md:flex">
            <NavLink to="/" end className={link}>Home</NavLink>
            <NavLink to="/browse/movie" className={link}>Films</NavLink>
            <NavLink to="/browse/tv" className={link}>Series</NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-2 md:ml-0">
            <button onClick={() => setSearch(true)} className="btn-ghost !px-3.5 !py-2" aria-label="Search">
              <Search size={17} />
              <span className="hidden text-bone-dim md:inline">Search</span>
              <kbd className="ml-1 hidden rounded border border-white/15 px-1.5 text-[10px] text-bone-mute lg:inline">/</kbd>
            </button>
            <div className="hidden h-9 w-9 items-center justify-center rounded-full bg-white/15 text-sm font-bold md:flex" title={label}>
              {label.slice(0, 1).toUpperCase()}
            </div>
          </div>
        </div>
      </header>

      {/* Phone / tablet: Nuvio-style bottom tabs */}
      <nav className="safe-b fixed inset-x-0 bottom-0 z-50 flex border-t border-white/[0.07] sheet bg-ink-950/85 backdrop-blur-xl md:hidden" aria-label="Main">
        <NavLink to="/" end className={tab}>
          <Home size={21} /> Home
        </NavLink>
        <NavLink to="/browse/movie" className={tab}>
          <Film size={21} /> Films
        </NavLink>
        <NavLink to="/browse/tv" className={tab}>
          <Tv size={21} /> Series
        </NavLink>
        <button onClick={() => setSearch(true)} className={tab({ isActive: false })}>
          <Search size={21} /> Search
        </button>
      </nav>
      {search && <SearchOverlay onClose={() => setSearch(false)} />}
    </>
  );
}
