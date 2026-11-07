import { Loader2, Zap } from "lucide-react";
import { canDirectPlay, playPath } from "../lib/compat";
import { fmtSize, releaseTags, resLabel } from "../lib/format";
import type { StreamsState } from "../lib/useStreams";
import type { StreamItem } from "../types";

interface Props {
  state: StreamsState;
  onPick: (item: StreamItem) => void;
  activeHash?: string | null;
  compact?: boolean;
}

export function StreamList({ state, onPick, activeHash, compact }: Props) {
  const { items, final, hidden, error, warning, indexers } = state;
  return (
    <div>
      <div className="mb-3 flex items-center gap-3 text-xs text-bone-mute">
        {!final ? (
          <>
            <Loader2 size={14} className="animate-spin" />
            <span>Checking sources{indexers.length ? ` · ${indexers.length} responded` : "…"}</span>
          </>
        ) : (
          <span>
            {items.length} playable source{items.length === 1 ? "" : "s"}
            {hidden > 0 && ` · ${hidden} more aren't cached yet`}
          </span>
        )}
      </div>

      {error && <div className="rounded-2xl border border-ember/30 bg-ember/10 p-4 text-sm text-ember">{error}</div>}
      {warning && !items.length && <div className="rounded-2xl border border-amber/30 bg-amber/10 p-4 text-sm text-amber">{warning}</div>}

      {!items.length && !final && (
        <div className="space-y-2">
          {[0, 1, 2].map((n) => (
            <div key={n} className="skeleton h-[60px] rounded-xl" />
          ))}
        </div>
      )}
      {!items.length && final && !error && !warning && (
        <div className="rounded-2xl border border-white/10 bg-ink-800/60 p-6 text-center text-sm text-bone-dim">
          Nothing cached for this one yet. Try again later, or ask the owner to loosen the quality settings.
        </div>
      )}

      <ul className="space-y-2">
        {items.map((it, idx) => {
          const direct = canDirectPlay(it.release);
          const tags = releaseTags(it.release);
          const active = activeHash === it.hash;
          return (
            <li key={it.hash} className="animate-rise" style={{ animationDelay: `${Math.min(idx, 8) * 30}ms` }}>
              <button
                onClick={() => onPick(it)}
                className={`group flex w-full items-center gap-4 rounded-2xl border p-3 text-left transition duration-200 ${
                  active ? "border-white/40 bg-white/[0.1]" : "border-white/[0.06] bg-white/[0.04] hover:border-white/20 hover:bg-white/[0.08]"
                } ${compact ? "py-2" : ""}`}
              >
                <div className={`flex h-11 w-14 shrink-0 items-center justify-center rounded-lg text-lg font-extrabold ${it.release.resolution >= 2160 ? "bg-white text-black" : "bg-white/10 text-bone"}`}>
                  {resLabel(it.release.resolution)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-bone/95">{it.title}</div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {tags.map((t) => (
                      <span key={t} className="chip">
                        {t}
                      </span>
                    ))}
                    {it.owned && (
                      <span className="chip chip-amber">
                        <Zap size={10} className="mr-0.5 fill-current" /> In your library
                      </span>
                    )}
                  </div>
                </div>
                <div className="hidden shrink-0 text-right sm:block">
                  <div className="text-sm font-semibold text-bone">{fmtSize(it.size)}</div>
                  <div className={`text-xs ${playPath(it.release) !== "hls" ? "text-moss" : "text-bone-mute"}`} title={direct.ok ? undefined : direct.reason}>
                    {direct.ok ? "Plays directly" : playPath(it.release) === "remux" ? "Instant · browser remux" : "Converted by TorBox"}
                  </div>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
