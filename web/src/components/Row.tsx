import { ChevronLeft, ChevronRight } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { Link } from "react-router-dom";

export function Row({ title, children, more }: { title: string; children: ReactNode; more?: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const scroll = (dir: -1 | 1) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.85, behavior: "smooth" });
  return (
    <section className="group/row row-cv row-reveal relative">
      <div className="mb-2.5 flex items-center justify-between px-5 md:px-10">
        <h2 className="text-lg font-bold tracking-tight md:text-[22px]">{title}</h2>
        {more && (
          <Link to={more} className="flex items-center gap-0.5 text-sm font-semibold text-bone-mute transition hover:text-bone">
            See all <ChevronRight size={16} />
          </Link>
        )}
      </div>
      <div className="relative">
        <div ref={ref} className="no-scrollbar snap-row flex gap-3 overflow-x-auto scroll-smooth px-5 pb-3 pt-1 md:gap-4 md:px-10">
          {children}
        </div>
        <button aria-label="Scroll left" onClick={() => scroll(-1)} className="absolute left-3 top-[40%] hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/70 opacity-0 transition hover:bg-black group-hover/row:opacity-100 md:flex">
          <ChevronLeft size={22} />
        </button>
        <button aria-label="Scroll right" onClick={() => scroll(1)} className="absolute right-3 top-[40%] hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/70 opacity-0 transition hover:bg-black group-hover/row:opacity-100 md:flex">
          <ChevronRight size={22} />
        </button>
      </div>
    </section>
  );
}
