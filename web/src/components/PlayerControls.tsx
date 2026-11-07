import { Captions, useCaptionOptions, useMediaRemote, useMediaState, type MediaPlayerInstance } from "@vidstack/react";
import "@vidstack/react/player/styles/default/captions.css";
import { Airplay, ArrowLeft, AudioLines, Cast, Check, Info, Expand, Gauge, Loader2, Maximize, Minimize, Pause, PictureInPicture2, Play, RotateCcw, RotateCw, Shrink, Subtitles, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { castTime, castToggle, startCast, stopCast, useCast, type CastMedia } from "../lib/cast";

/** Nuvio-style overlay: big centre transport, ±10 s arc buttons, tap-to-seek bar, side panels,
 *  hold for 2×, double-tap sides to skip, auto-hide, and a pause screen with the title. */

export interface AudioOption {
  value: number;
  label: string;
  selected: boolean;
}

interface Props {
  player: RefObject<MediaPlayerInstance>;
  title: string;
  subtitle?: string;
  overview?: string;
  audio: AudioOption[];
  audioBusy: boolean;
  onAudio: (value: number) => void;
  onScanAudio?: () => void; // reopen the file in a mode that reads every audio track (direct play can't)
  extra?: ReactNode; // e.g. the next-episode button, kept above the bar
  notice?: ReactNode; // a quiet message under the top bar
  info?: ReactNode; // contents of the info panel (method, file, device)
  actions?: ReactNode; // top-right buttons, e.g. Sources
  cast?: Omit<CastMedia, "time"> | null; // what a TV can fetch itself (never the in-browser remux)
  onBack: () => void;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const HIDE_MS = 3200;
type Panel = "audio" | "subs" | "speed" | "info" | null;

const clock = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${String(sec).padStart(2, "0")}`;
};

export function PlayerControls(p: Props) {
  const remote = useMediaRemote(p.player);
  const paused = useMediaState("paused", p.player);
  const waiting = useMediaState("waiting", p.player);
  const started = useMediaState("started", p.player);
  const time = useMediaState("currentTime", p.player);
  const duration = useMediaState("duration", p.player);
  const buffered = useMediaState("bufferedEnd", p.player);
  const fullscreen = useMediaState("fullscreen", p.player);
  const canPip = useMediaState("canPictureInPicture", p.player);
  const rate = useMediaState("playbackRate", p.player);
  const canAirPlay = useMediaState("canAirPlay", p.player);
  const cast = useCast();
  const casting = cast.state === "connected" || cast.state === "connecting";
  const [castErr, setCastErr] = useState("");
  useEffect(() => {
    if (casting) remote.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [casting]);
  const castHere = () => {
    if (!p.cast) return;
    setCastErr("");
    startCast({ ...p.cast, time: p.player.current?.currentTime ?? 0 }).catch((e) => {
      if (String(e) !== "cancel") setCastErr("That TV couldn't play this file. Try another source.");
    });
  };
  const stopCasting = () => {
    const t = castTime();
    stopCast();
    if (t > 0) remote.seek(t);
    remote.play();
  };
  const captions = useCaptionOptions();

  const [shown, setShown] = useState(true);
  const [panel, setPanel] = useState<Panel>(null);
  const [fill, setFill] = useState(false);
  const [scrub, setScrub] = useState<number | null>(null);
  const [skip, setSkip] = useState<{ dir: -1 | 1; n: number } | null>(null);
  const [boost, setBoost] = useState(false);
  const [pausedLong, setPausedLong] = useState(false);
  const hideT = useRef<number>();
  const skipT = useRef<number>();
  const holdT = useRef<number>();
  const lastTap = useRef<{ t: number; x: number } | null>(null);
  const rateBeforeBoost = useRef(1);
  const bar = useRef<HTMLDivElement>(null);

  const poke = useCallback(() => {
    setShown(true);
    window.clearTimeout(hideT.current);
    hideT.current = window.setTimeout(() => setShown(false), HIDE_MS);
  }, []);
  useEffect(() => () => [hideT, skipT, holdT].forEach((r) => window.clearTimeout(r.current)), []);

  // Stay visible while paused or a panel is open; otherwise fade out after a moment of no input.
  const visible = shown || paused || panel !== null || scrub !== null || !started;
  useEffect(() => {
    if (!paused) return setPausedLong(false);
    const t = window.setTimeout(() => setPausedLong(true), 5000);
    return () => window.clearTimeout(t);
  }, [paused]);

  const seekBy = (dir: -1 | 1) => {
    const pl = p.player.current;
    if (!pl) return;
    remote.seek(Math.max(0, Math.min(duration || Infinity, pl.currentTime + dir * 10)));
    setSkip((s) => ({ dir, n: s && s.dir === dir ? s.n + 1 : 1 }));
    window.clearTimeout(skipT.current);
    skipT.current = window.setTimeout(() => setSkip(null), 700);
  };

  // Surface gestures: tap toggles controls, double-tap a side skips, press-and-hold plays at 2×.
  const onDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    window.clearTimeout(holdT.current);
    holdT.current = window.setTimeout(() => {
      rateBeforeBoost.current = p.player.current?.playbackRate || 1;
      remote.changePlaybackRate(2);
      setBoost(true);
    }, 450);
  };
  const onUp = (e: React.PointerEvent) => {
    window.clearTimeout(holdT.current);
    if (boost) {
      remote.changePlaybackRate(rateBeforeBoost.current);
      setBoost(false);
      return;
    }
    if (panel) return setPanel(null);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const now = Date.now();
    const prev = lastTap.current;
    if (prev && now - prev.t < 300 && Math.abs(prev.x - x) < 0.2 && (x < 0.35 || x > 0.65)) {
      lastTap.current = null;
      seekBy(x < 0.5 ? -1 : 1);
      return;
    }
    lastTap.current = { t: now, x };
    if (e.pointerType === "mouse") {
      remote.togglePaused();
      poke();
    } else if (visible && !paused) setShown(false);
    else poke();
  };

  const posFrom = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * (duration || 0);
  };
  const onBarDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setScrub(posFrom(e.clientX));
  };
  const onBarMove = (e: React.PointerEvent) => scrub !== null && setScrub(posFrom(e.clientX));
  const onBarUp = (e: React.PointerEvent) => {
    e.stopPropagation();
    if (scrub !== null) remote.seek(scrub);
    setScrub(null);
    poke();
  };

  const shownTime = scrub ?? time;
  const pct = duration > 0 ? (shownTime / duration) * 100 : 0;
  const bufPct = duration > 0 ? Math.min(100, (buffered / duration) * 100) : 0;
  const subsOn = captions.selectedValue !== "off";
  const fade = `transition-opacity duration-300 ${visible ? "opacity-100" : "pointer-events-none opacity-0"}`;

  return (
    <div
      className={`absolute inset-0 select-none ${fill ? "[&_video]:object-cover" : ""} ${visible ? "" : "cursor-none"}`}
      onPointerMove={(e) => e.pointerType === "mouse" && poke()}
    >
      <Captions className="vds-captions pointer-events-none absolute inset-0 transition-[bottom] duration-300" style={{ bottom: visible ? "4.5rem" : "0.5rem" }} />

      {/* gesture surface */}
      <div className="absolute inset-0" onPointerDown={onDown} onPointerUp={onUp} onPointerCancel={() => window.clearTimeout(holdT.current)} />

      {/* pause screen */}
      {pausedLong && !panel && (
        <div className="pointer-events-none absolute inset-0 flex items-end bg-gradient-to-r from-black/85 via-black/40 to-transparent px-[6%] pb-[clamp(110px,16vh,170px)] animate-fade">
          <div className="max-w-[55%]">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-bone-mute">You're watching</p>
            <h2 className="mt-2 font-display text-[clamp(1.25rem,3.4vw,2.75rem)] font-bold leading-tight text-bone">{p.title}</h2>
            {p.subtitle && <p className="mt-1 text-sm text-bone-dim">{p.subtitle}</p>}
            {p.overview && <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-bone-dim">{p.overview}</p>}
          </div>
        </div>
      )}

      {/* gradients + top bar */}
      <div className={`pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/80 to-transparent ${fade}`} />
      <div className={`pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-black/90 to-transparent ${fade}`} />
      <div className={`safe-t absolute left-0 right-0 top-0 flex items-center gap-2 p-[clamp(10px,2vw,22px)] sm:gap-3 ${fade}`}>
        <Btn label="Back" onClick={p.onBack}>
          <ArrowLeft size={22} />
        </Btn>
        <div className="pointer-events-none min-w-0 flex-1">
          <h3 className="truncate text-[clamp(0.95rem,1.8vw,1.2rem)] font-semibold text-bone">{p.title}</h3>
          {p.subtitle && <p className="truncate text-xs text-bone-dim sm:text-sm">{p.subtitle}</p>}
        </div>
        {p.cast && cast.state !== "unavailable" && (
          <Btn label={casting ? `Casting to ${cast.device || "TV"}` : "Cast to TV"} active={casting} onClick={casting ? stopCasting : castHere}>
            <Cast size={19} />
          </Btn>
        )}
        {canAirPlay && (
          <Btn label="AirPlay" onClick={() => remote.requestAirPlay()}>
            <Airplay size={19} />
          </Btn>
        )}
        {p.info && (
          <Btn label="Playback info" active={panel === "info"} onClick={() => setPanel(panel === "info" ? null : "info")}>
            <Info size={19} />
          </Btn>
        )}
        {p.actions}
      </div>
      {p.notice && <div className={`absolute inset-x-0 top-[clamp(64px,9vw,92px)] flex justify-center px-4 ${fade}`}>{p.notice}</div>}

      {casting && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 bg-black/85 px-6 text-center">
          <Cast size={40} className="text-amber-glow" />
          <p className="text-lg font-semibold text-bone">{cast.state === "connecting" ? "Connecting…" : `Playing on ${cast.device || "your TV"}`}</p>
          <div className="flex gap-3">
            <button className="btn-ghost !px-5" onClick={castToggle}>Play / Pause</button>
            <button className="btn-primary !px-5" onClick={stopCasting}>Stop casting</button>
          </div>
        </div>
      )}
      {castErr && <div className="absolute left-1/2 top-20 z-30 -translate-x-1/2 rounded-full bg-black/80 px-4 py-2 text-xs text-ember">{castErr}</div>}

      {/* centre transport */}
      <div className={`pointer-events-none absolute inset-0 flex items-center justify-center gap-[clamp(28px,9vw,96px)] ${fade}`}>
        <SkipButton dir={-1} active={skip?.dir === -1 ? skip.n : 0} onClick={() => (seekBy(-1), poke())} />
        <button
          aria-label={paused ? "Play" : "Pause"}
          onClick={() => (remote.togglePaused(), poke())}
          className="pointer-events-auto relative grid size-[clamp(56px,9vw,84px)] place-items-center rounded-full bg-white/10 text-bone ring-1 ring-white/15 backdrop-blur-md transition hover:scale-105 hover:bg-white/20 active:scale-95"
        >
          {waiting && started ? (
            <Loader2 className="size-1/2 animate-spin" />
          ) : (
            <>
              <Play className={`absolute size-[42%] translate-x-[6%] fill-current transition-all duration-200 ${paused ? "scale-100 opacity-100" : "scale-50 opacity-0"}`} />
              <Pause className={`absolute size-[42%] fill-current transition-all duration-200 ${paused ? "scale-50 opacity-0" : "scale-100 opacity-100"}`} />
            </>
          )}
        </button>
        <SkipButton dir={1} active={skip?.dir === 1 ? skip.n : 0} onClick={() => (seekBy(1), poke())} />
      </div>

      {/* double-tap ripple when controls are hidden */}
      {skip && !visible && (
        <div className={`pointer-events-none absolute inset-y-0 flex w-1/3 items-center justify-center ${skip.dir < 0 ? "left-0" : "right-0"}`}>
          <span className="rounded-full bg-black/50 px-4 py-2 text-sm font-semibold text-bone backdrop-blur animate-fade">
            {skip.dir < 0 ? "−" : "+"}
            {skip.n * 10}s
          </span>
        </div>
      )}
      {boost && (
        <div className="pointer-events-none absolute left-1/2 top-5 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/60 px-3 py-1.5 text-xs font-semibold text-bone backdrop-blur">
          <Gauge size={13} /> 2× speed
        </div>
      )}

      {/* bottom bar */}
      <div className={`absolute inset-x-0 bottom-0 px-[clamp(12px,2.2vw,24px)] pb-[clamp(8px,1.6vw,18px)] ${fade}`}>
        {p.extra}
        <div className="flex items-center gap-3 text-[11px] tabular-nums text-bone-dim sm:text-xs">
          <span className="w-12 text-bone">{clock(shownTime)}</span>
          <div
            ref={bar}
            role="slider"
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={Math.floor(duration || 0)}
            aria-valuenow={Math.floor(shownTime)}
            className="group relative flex h-6 flex-1 cursor-pointer touch-none items-center"
            onPointerDown={onBarDown}
            onPointerMove={onBarMove}
            onPointerUp={onBarUp}
          >
            <div className="relative h-1 w-full overflow-hidden rounded-full bg-white/20 transition-[height] group-hover:h-1.5">
              <div className="absolute inset-y-0 left-0 bg-white/35" style={{ width: `${bufPct}%` }} />
              <div className="absolute inset-y-0 left-0 bg-amber" style={{ width: `${pct}%` }} />
            </div>
            <div
              className={`absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow transition-transform ${scrub !== null ? "scale-125" : "scale-0 group-hover:scale-100"}`}
              style={{ left: `${pct}%` }}
            />
            {scrub !== null && (
              <div className="absolute -top-8 -translate-x-1/2 rounded-md bg-black/80 px-2 py-1 text-xs text-bone" style={{ left: `${pct}%` }}>
                {clock(scrub)}
              </div>
            )}
          </div>
          <span className="w-14 text-right">-{clock(Math.max(0, (duration || 0) - shownTime))}</span>
        </div>
        <div className="mt-1 flex items-center gap-1 sm:gap-2">
          <Btn label={paused ? "Play" : "Pause"} onClick={() => remote.togglePaused()}>
            {paused ? <Play size={18} className="fill-current" /> : <Pause size={18} className="fill-current" />}
          </Btn>
          <div className="flex-1" />
          <Btn label="Audio" active={panel === "audio"} onClick={() => setPanel(panel === "audio" ? null : "audio")}>
            <AudioLines size={18} />
          </Btn>
          {captions.length > 1 && (
            <Btn label="Subtitles" active={panel === "subs" || subsOn} onClick={() => setPanel(panel === "subs" ? null : "subs")}>
              <Subtitles size={18} />
            </Btn>
          )}
          <Btn label="Speed" active={panel === "speed" || rate !== 1} onClick={() => setPanel(panel === "speed" ? null : "speed")}>
            <Gauge size={18} />
            {rate !== 1 && <span className="ml-0.5 text-[11px] font-semibold">{rate}×</span>}
          </Btn>
          <Btn label={fill ? "Fit to screen" : "Fill screen"} onClick={() => setFill((f) => !f)}>
            {fill ? <Shrink size={18} /> : <Expand size={18} />}
          </Btn>
          {canPip && (
            <Btn label="Picture in picture" onClick={() => remote.togglePictureInPicture()}>
              <PictureInPicture2 size={18} />
            </Btn>
          )}
          <Btn label={fullscreen ? "Exit full screen" : "Full screen"} onClick={() => remote.toggleFullscreen()}>
            {fullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
          </Btn>
        </div>
      </div>

      {/* side panel */}
      <div
        className={`absolute inset-y-0 right-0 z-40 sheet flex w-[min(320px,80%)] flex-col bg-ink-950/90 backdrop-blur-xl transition-transform duration-300 ${panel ? "translate-x-0" : "pointer-events-none translate-x-full"}`}
      >
        <div className="flex items-center justify-between px-5 pb-2 pt-5">
          <h4 className="text-sm font-semibold text-bone">{panel === "audio" ? "Audio" : panel === "subs" ? "Subtitles" : panel === "info" ? "Playback info" : "Playback speed"}</h4>
          <button aria-label="Close" onClick={() => setPanel(null)} className="rounded-full p-1.5 text-bone-dim hover:bg-white/10 hover:text-bone">
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-3 pb-4">
          {panel === "audio" && p.audio.length <= 1 && (
            <>
              <Row selected onClick={() => undefined}>
                {p.audio[0]?.label || "Original audio"}
              </Row>
              {p.onScanAudio ? (
                <>
                  <p className="px-3 pt-3 text-xs leading-relaxed text-bone-mute">
                    Only one track is visible while this file plays directly. Check the file itself to list every track it
                    has; it keeps your place.
                  </p>
                  <button
                    onClick={() => (setPanel(null), p.onScanAudio!())}
                    className="mx-3 mt-3 rounded-full bg-white px-4 py-2 text-xs font-semibold text-black hover:bg-bone-dim"
                  >
                    Check the file for other tracks
                  </button>
                </>
              ) : (
                <p className="px-3 pt-3 text-xs leading-relaxed text-bone-mute">
                  This file has one audio track. For other languages, pick a different source under Sources.
                </p>
              )}
            </>
          )}
          {panel === "audio" &&
            p.audio.length > 1 &&
            p.audio.map((a) => (
              <Row key={a.value} selected={a.selected} disabled={p.audioBusy} onClick={() => p.onAudio(a.value)}>
                {a.label}
              </Row>
            ))}
          {panel === "subs" &&
            captions.map((c) => (
              <Row key={c.value} selected={c.selected} onClick={() => c.select()}>
                {c.label}
              </Row>
            ))}
          {panel === "info" && <div className="space-y-3 px-3 text-xs leading-relaxed text-bone-dim">{p.info}</div>}
          {panel === "speed" &&
            SPEEDS.map((s) => (
              <Row key={s} selected={rate === s} onClick={() => remote.changePlaybackRate(s)}>
                {s === 1 ? "Normal" : `${s}×`}
              </Row>
            ))}
        </div>
      </div>
    </div>
  );
}

function SkipButton({ dir, active, onClick }: { dir: -1 | 1; active: number; onClick: () => void }) {
  const Icon = dir < 0 ? RotateCcw : RotateCw;
  return (
    <button
      aria-label={dir < 0 ? "Back 10 seconds" : "Forward 10 seconds"}
      onClick={onClick}
      className="pointer-events-auto relative grid size-[clamp(44px,6.5vw,60px)] place-items-center rounded-full text-bone transition hover:bg-white/10 active:scale-90"
    >
      {/* arc sweep: replays on every press via the key */}
      <Icon key={active} className={`size-[70%] ${active ? (dir < 0 ? "animate-[spin_.45s_ease-out_reverse_1]" : "animate-[spin_.45s_ease-out_1]") : ""}`} strokeWidth={1.6} />
      <span className="absolute text-[clamp(9px,1.1vw,11px)] font-bold">{active > 1 ? active * 10 : 10}</span>
    </button>
  );
}

function Btn({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex h-9 min-w-9 items-center justify-center rounded-full px-2 transition hover:bg-white/10 ${active ? "text-amber-glow" : "text-bone"}`}
    >
      {children}
    </button>
  );
}

function Row({ selected, disabled, onClick, children }: { selected: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition hover:bg-white/[0.06] disabled:opacity-50 ${selected ? "bg-white/[0.08] text-bone" : "text-bone-dim"}`}
    >
      <span className="line-clamp-2 break-words">{children}</span>
      {selected && <Check size={15} className="shrink-0 text-amber-glow" />}
    </button>
  );
}
