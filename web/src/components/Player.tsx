import { isHLSProvider, isVideoProvider, MediaPlayer, MediaProvider, Track, type MediaPlayerInstance, type PlayerSrc } from "@vidstack/react";
import "@vidstack/react/player/styles/default/theme.css";
import { AlertTriangle, ArrowLeft, Loader2, SkipForward, X, Zap } from "lucide-react";
import type { AudioTrack as VAudioTrack } from "@vidstack/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, img, post, sessionHeaders, withSession } from "../api";
import { isSafari, playPath } from "../lib/compat";
import { device } from "../lib/device";
import { epLabel, fmtSize } from "../lib/format";
import { planFile, type Plan, type Stage } from "../lib/plan";
import { audioScore, RemuxSession, remuxSupported, warmRemux } from "../lib/remux";
import { PlayerControls, type AudioOption } from "./PlayerControls";
import type { AudioTrack, MediaType, PlayResult, Release, SubtitleTrack } from "../types";

interface Props {
  type: MediaType;
  id: number;
  season: number | null;
  episode: number | null;
  hash: string;
  release: Release | null;
  waitForRelease: boolean;
  title: string;
  poster: string | null;
  backdrop: string | null;
  resume: number;
  /** Expected length in minutes (films only): a file far off this is probably a different film. */
  runtime: number | null;
  next: { season: number; episode: number } | null;
  onNext: () => void;
  onFail: (message: string) => void;
  onBack: () => void;
  actions?: React.ReactNode;
}

const PREF_KEY = "mq_audio_lang_v2"; // v2: English default; older saved choices came from the device language
const prefLang = () => {
  try {
    return localStorage.getItem(PREF_KEY) || "en"; // English unless the viewer picked another language themselves
  } catch {
    return "en";
  }
};
const fmtRuntime = (min: number) => (min >= 60 ? `${Math.floor(min / 60)}h ${Math.round(min % 60)}m` : `${Math.round(min)}m`);
const lang2 = (v?: string) => (v || "").toLowerCase().slice(0, 2);
const audioLabel = (a: AudioTrack, i: number) => a.title || a.name || (a.language ? a.language.toUpperCase() : `Track ${i + 1}`);

export function Player(p: Props) {
  const player = useRef<MediaPlayerInstance>(null);
  const directRef = useRef<PlayResult | null>(null); // the plain file URL, for casting while the browser remuxes
  const [ready, setReady] = useState<PlayResult | null>(null);
  const [status, setStatus] = useState("Finding the fastest route…");
  const [error, setError] = useState<string | null>(null);
  const [subs, setSubs] = useState<SubtitleTrack[]>([]);
  const [audio, setAudio] = useState<number | null>(null);
  const [showNext, setShowNext] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [native, setNative] = useState<{ label: string; lang: string; selected: boolean }[]>([]);
  const [waited, setWaited] = useState(0);
  const [mismatch, setMismatch] = useState<string | null>(null);
  const autoLang = useRef(false);
  const remux = useRef<RemuxSession | null>(null);
  const [remuxAudios, setRemuxAudios] = useState<{ label: string; lang: string; copy: boolean }[]>([]);
  const dev = device();
  const dropRemux = () => {
    remux.current?.destroy();
    remux.current = null;
    setRemuxAudios([]);
  };

  useEffect(() => warmRemux(), []);
  const t0 = useRef(Date.now());
  const [startMs, setStartMs] = useState<number | null>(null);
  const resumeAt = useRef(p.resume);
  const resumed = useRef(false);
  const playing = useRef(false); // has this source produced a frame yet?
  const tried = useRef<Set<Stage>>(new Set());
  const directRes = useRef<PlayResult | null>(null);
  const startedFor = useRef<string | null>(null);

  const playReq = useCallback(
    (mode: "direct" | "hls", audioIndex?: number | null) =>
      post<PlayResult>("/api/play", { media_type: p.type, tmdb_id: p.id, hash: p.hash, season: p.season, episode: p.episode, mode, audio_index: audioIndex ?? undefined }),
    [p.type, p.id, p.hash, p.season, p.episode],
  );

  const fail = useCallback(
    (e: unknown) => {
      const msg = e instanceof ApiError ? e.message : "Playback failed. Try another source.";
      setError(msg);
      p.onFail(msg);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.onFail],
  );

  /** Turn a plan into something the player can load. */
  const realise = useCallback(
    async (direct: PlayResult, plan: Plan, isCancelled: () => boolean): Promise<PlayResult | null> => {
      directRef.current = direct;
      if (plan.stage === "direct") {
        tried.current.add("direct");
        return { ...direct, mode: "direct", url: plan.src ?? direct.url, note: plan.note };
      }
      if (plan.stage === "remux" && plan.session) {
        const session = plan.session;
        if (isCancelled()) {
          session.destroy();
          return null;
        }
        tried.current.add("remux");
        session.onError = (e) => void fallbackRef.current("remux", (e as Error)?.message || String(e));
        remux.current = session;
        setRemuxAudios(session.audios.map((a) => ({ label: a.label, lang: a.lang, copy: a.copy })));
        setAudio(session.audioIndex);
        resumed.current = true; // the session starts at the right second by itself
        return { ...direct, mode: "remux", url: session.url, mime: "video/mp4", note: plan.note };
      }
      tried.current.add("hls");
      setStatus("Preparing a stream your device can play…");
      return { ...(await playReq("hls")), note: plan.note };
    },
    [playReq],
  );

  // Pick the method for THIS device, ask the server for a link, hand it to the player.
  useEffect(() => {
    if (p.waitForRelease) return;
    const key = `${p.type}:${p.id}:${p.season}:${p.episode}:${p.hash}`;
    if (startedFor.current === key) return;
    if (startedFor.current !== null) resumeAt.current = player.current?.currentTime || resumeAt.current; // switching source mid-film
    startedFor.current = key;
    t0.current = Date.now();
    setStartMs(null);

    let cancelled = false;
    setReady(null);
    setError(null);
    setShowNext(false);
    setMismatch(null);
    resumed.current = false;
    playing.current = false;
    tried.current = new Set();
    directRes.current = null;
    autoLang.current = false;
    setNative([]);
    setAudio(null);
    (async () => {
      try {
        dropRemux();
        let res: PlayResult | null;
        if (p.release && !remuxSupported() && playPath(p.release) === "hls") {
          // Old browser that can neither play nor repackage this file: straight to the transcode.
          setStatus("Preparing a transcoded stream…");
          tried.current.add("hls");
          res = await playReq("hls");
        } else {
          setStatus("Preparing the stream…");
          const direct = await playReq("direct");
          directRes.current = direct;
          if (cancelled) return;
          setStatus(`Checking what your ${dev.kind === "desktop" ? "browser" : dev.kind} can play…`);
          const plan = await planFile(direct, resumeAt.current, prefLang());
          if (cancelled) {
            plan.session?.destroy();
            return;
          }
          res = await realise(direct, plan, () => cancelled);
        }
        if (res && !cancelled) setReady(res);
      } catch (e) {
        if (!cancelled) fail(e);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.type, p.id, p.season, p.episode, p.hash, p.waitForRelease, p.release, playReq, fail, realise]);
  useEffect(() => () => dropRemux(), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Elapsed seconds while preparing, so a slow transcode doesn't look like a hang.
  useEffect(() => {
    if (ready || error) return setWaited(0);
    const t0 = Date.now();
    const t = setInterval(() => setWaited(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(t);
  }, [ready, error]);

  // Something didn't work: step down one rung (direct -> browser remux -> TorBox transcode), keeping the position.
  const fallback = useCallback(
    async (from: Stage, reason = "") => {
      console.warn("[marquee] falling back from", from, reason);
      tried.current.add(from);
      resumeAt.current = player.current?.currentTime || resumeAt.current;
      resumed.current = false;
      dropRemux();
      setReady(null);
      try {
        const d = directRes.current;
        if (from === "direct" && d && !tried.current.has("remux") && remuxSupported()) {
          tried.current.add("remux");
          setStatus(reason === "reading every audio track" ? "Reading the file's audio tracks…" : "Direct playback didn't work. Repackaging in your browser…");
          const plan = await planFile(d, resumeAt.current, prefLang(), { preferProxy: true, forceRemux: true });
          if (plan.stage === "remux") {
            const res = await realise(d, plan, () => false);
            if (res) return void setReady(res);
          }
          plan.session?.destroy();
        }
        if (!tried.current.has("hls")) {
          tried.current.add("hls");
          setStatus("Switching to a transcoded stream…");
          const res = await playReq("hls", audio);
          return void setReady({ ...res, note: `${from === "remux" ? "Browser remux" : "Direct play"} stopped${reason ? ` (${reason.slice(0, 120)})` : ""}, so TorBox converts it` });
        }
        setError("This file won't play on this device, even transcoded. Try another source.");
        p.onFail("Playback failed");
      } catch (e) {
        fail(e);
      }
    },
    [playReq, realise, audio, fail, p],
  );
  const fallbackRef = useRef<(s: Stage, reason?: string) => Promise<void>>(async () => undefined);
  fallbackRef.current = fallback;

  // Never started? Don't leave the viewer staring at a spinner. A remux that keeps receiving data is slow, not
  // stuck (a 4K file over a modest link), so it gets more time as long as bytes keep arriving.
  useEffect(() => {
    if (!ready || ready.mode === "hls") return;
    const mode = ready.mode as Stage;
    let last = -1;
    let stalls = 0;
    const t = setInterval(() => {
      if (playing.current) return clearInterval(t);
      const got = remux.current?.appended ?? 0;
      stalls = mode === "remux" && got > last ? 0 : stalls + 1;
      last = got;
      if (stalls >= 3) {
        clearInterval(t);
        void fallbackRef.current(mode, "no data arrived for 15 s");
      }
    }, 5000);
    return () => clearInterval(t);
  }, [ready]);

  // Audio switching. Browser remux: instant, in place. HLS: the manifest carries every language where TorBox
  // makes one, otherwise a new stream is built while the current one KEEPS PLAYING, then swapped at the same second.
  const rememberLang = (lang?: string) => {
    try {
      if (lang) localStorage.setItem(PREF_KEY, lang2(lang));
    } catch {
      /* private mode */
    }
  };
  const changeAudio = async (index: number) => {
    const pl = player.current;
    const meta = (ready?.audios ?? []).find((a, i) => (a.index ?? i) === index);
    rememberLang(meta?.language);
    if (remux.current) {
      const rs = remux.current;
      rememberLang(rs.audios[index]?.lang);
      setAudio(index);
      setSwitching("Switching audio…");
      try {
        await rs.switchAudio(index);
      } finally {
        setSwitching(null);
      }
      return;
    }
    if (native.length > 1 && pl?.audioTracks[index]) {
      pl.audioTracks[index].selected = true; // instant
      return;
    }
    const at = pl?.currentTime || resumeAt.current;
    const was = audio;
    setAudio(index);
    setSwitching("Switching audio. TorBox is preparing it, the film keeps playing meanwhile…");
    try {
      const res = await playReq("hls", index);
      resumeAt.current = Math.max(0, (player.current?.currentTime ?? at) - 1);
      resumed.current = false;
      tried.current.add("hls");
      setReady(res);
    } catch (e) {
      setAudio(was);
      setToast(e instanceof ApiError ? e.message : "Couldn't switch audio.");
      setTimeout(() => setToast(null), 5000);
    } finally {
      setSwitching(null);
    }
  };

  // Use the viewer's usual language automatically (once per source) when it exists and isn't already selected.
  const applyPreferredAudio = (tracks: { lang: string; selected: boolean }[]) => {
    if (autoLang.current || tracks.length < 2) return;
    autoLang.current = true;
    const want = prefLang();
    const cur = tracks.findIndex((t) => t.selected);
    const i = tracks.findIndex((t) => lang2(t.lang) === want);
    if (i >= 0 && i !== cur && player.current?.audioTracks[i]) player.current.audioTracks[i].selected = true;
  };

  // External subtitles
  useEffect(() => {
    setSubs([]);
    const qs = p.type === "tv" ? `?season=${p.season}&episode=${p.episode}` : "";
    api<SubtitleTrack[]>(`/api/subtitles/${p.type}/${p.id}${qs}`).then(setSubs).catch(() => undefined);
  }, [p.type, p.id, p.season, p.episode]);

  // Save position every 15s, when hidden, and on exit.
  const save = useCallback(() => {
    const pl = player.current;
    if (!pl || !playing.current) return;
    const duration = pl.duration;
    if (!isFinite(duration) || duration <= 0) return;
    void fetch("/api/history", {
      method: "PUT",
      keepalive: true,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...sessionHeaders() },
      body: JSON.stringify({ media_type: p.type, tmdb_id: p.id, season: p.season, episode: p.episode, position: pl.currentTime, duration, title: p.title, poster: p.poster, backdrop: p.backdrop }),
    });
  }, [p.type, p.id, p.season, p.episode, p.title, p.poster, p.backdrop]);

  useEffect(() => {
    const t = setInterval(save, 15000);
    const onHide = () => document.visibilityState === "hidden" && save();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", save);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", save);
      save();
    };
  }, [save]);

  const bg = img(p.backdrop, "w780");
  const audios = ready?.audios ?? [];
  // One audio list for the panel, whichever method is playing.
  const nativeSel = native.findIndex((n) => n.selected);
  const audioOptions: AudioOption[] = !ready
    ? []
    : ready.mode === "remux"
    ? remuxAudios
        .map((a, i) => ({ value: i, label: a.label, selected: (audio ?? 0) === i, score: audioScore(a, prefLang()) }))
        .sort((x, y) => y.score - x.score || x.value - y.value) // the viewer's language first, file order otherwise
    : native.length > 1
    ? native.map((n, i) => ({ value: i, label: n.label || (n.lang ? n.lang.toUpperCase() : `Track ${i + 1}`), selected: (nativeSel < 0 ? 0 : nativeSel) === i }))
    : ready.mode === "hls"
    ? audios.map((a, i) => ({ value: a.index ?? i, label: audioLabel(a, i), selected: (audio ?? audios[0]?.index ?? 0) === (a.index ?? i) }))
    : [];
  const methodLabel = ready ? (ready.mode === "direct" ? "Direct play" : ready.mode === "remux" ? "Browser remux" : "Transcoded by TorBox") : "";

  return (
    <div className="h-full w-full">
      <div className="player relative h-full w-full overflow-hidden bg-black">
        {ready && !error && (
          <MediaPlayer
            ref={player}
            key={p.hash + ":" + ready.mode + ":" + ready.url.slice(-24)}
            storage="marquee-player"
            poster={bg}
            keyTarget="document"
            className="h-full w-full"
            title={p.title}
            src={{ src: ready.url, type: ready.mime } as PlayerSrc}
            crossOrigin={ready.mode === "hls" && !isSafari ? "anonymous" : undefined}
            playsInline
            autoPlay
            onProviderSetup={(provider) => {
              if (remux.current && isVideoProvider(provider)) remux.current.bind(provider.video);
            }}
            onProviderChange={(provider) => {
              if (isHLSProvider(provider)) {
                provider.library = () => import("hls.js");
                provider.config = { maxBufferLength: 40, maxMaxBufferLength: 90, backBufferLength: 30, enableWorker: true, capLevelToPlayerSize: true, startFragPrefetch: true, manifestLoadingMaxRetry: 4, levelLoadingMaxRetry: 4, fragLoadingMaxRetry: 6, nudgeMaxRetry: 8 };
              }
            }}
            onCanPlay={() => {
              if (!playing.current) {
                // Only a known, full length can say "wrong film": TorBox's transcode reports just the part
                // converted so far (or no length at all), and longer cuts (extended, director's) are fine.
                const d = player.current?.duration ?? 0;
                if (ready.mode !== "hls" && p.runtime && isFinite(d) && d > 60 && d / 60 < p.runtime * 0.7) {
                  setMismatch(`This file runs ${fmtRuntime(d / 60)}, but the film is ${fmtRuntime(p.runtime)}. It may be a different film with the same name.`);
                }
                setStartMs(Date.now() - t0.current);
                console.info("[marquee] started", ready.mode, `${Date.now() - t0.current}ms`);
              }
              playing.current = true;
              const pl = player.current;
              if (pl && !resumed.current && resumeAt.current > 5) pl.currentTime = resumeAt.current;
              resumed.current = true;
            }}
            onTimeUpdate={({ currentTime }) => {
              const d = player.current?.duration ?? 0;
              if (p.next && d > 300) setShowNext(d - currentTime < 40);
            }}
            onAudioTracksChange={() => {
              const list = (player.current?.audioTracks ? Array.from(player.current.audioTracks as Iterable<VAudioTrack>) : []).map((t) => ({ label: t.label, lang: t.language ?? "", selected: t.selected }));
              setNative(list);
              if (list.length > 1) {
                const sel = list.findIndex((t) => t.selected);
                if (sel >= 0) setAudio(sel);
                applyPreferredAudio(list);
              }
            }}
            onEnded={() => p.next && p.onNext()}
            onError={(detail) => {
              if (ready.mode !== "hls") return void fallback(ready.mode as Stage);
              const why = [detail?.code, detail?.message].filter(Boolean).join(" ");
              const msg = `The stream stopped working${why ? ` (${why})` : ""}.`;
              console.error("[marquee] playback error", detail);
              setError(msg);
              p.onFail(msg);
            }}
          >
            <MediaProvider>
              {subs.map((s) => (
                <Track key={s.id} src={withSession(s.url)} kind="subtitles" label={s.label} lang={s.lang} />
              ))}
            </MediaProvider>
            <PlayerControls
              player={player}
              title={p.title}
              subtitle={p.type === "tv" && p.season != null && p.episode != null ? epLabel(p.season, p.episode) : undefined}
              audio={audioOptions}
              audioBusy={!!switching}
              onAudio={(v) => void changeAudio(v)}
              onScanAudio={
                ready.mode === "direct" && remuxSupported() && audioOptions.length <= 1
                  ? () => void fallbackRef.current("direct", "reading every audio track")
                  : undefined
              }
              onBack={p.onBack}
              actions={p.actions}
              cast={
                ready.mode === "hls"
                  ? { url: ready.url, mime: "application/x-mpegURL", title: p.title, poster: bg }
                  : (ready.mode === "direct" ? ready.url : directRef.current?.url)
                    ? { url: (ready.mode === "direct" ? ready.url : directRef.current!.url), mime: "video/mp4", title: p.title, poster: bg }
                    : null
              }
              notice={
                mismatch ? (
                  <div className="flex max-w-full items-center gap-3 rounded-full bg-black/55 py-1.5 pl-4 pr-1.5 text-xs text-bone-dim ring-1 ring-white/10 backdrop-blur-md animate-fade">
                    <AlertTriangle size={14} className="shrink-0 text-amber-glow" />
                    <span className="truncate">{mismatch}</span>
                    <button className="shrink-0 rounded-full bg-white px-3 py-1 font-semibold text-black hover:bg-bone-dim" onClick={() => (player.current?.pause(), p.onFail("That file looked like a different film. Pick another source."))}>
                      Switch
                    </button>
                    <button aria-label="Dismiss" className="shrink-0 rounded-full p-1 text-bone-mute hover:text-bone" onClick={() => setMismatch(null)}>
                      <X size={14} />
                    </button>
                  </div>
                ) : null
              }
              info={
                <>
                  <p>
                    <span className={`chip ${ready.mode === "hls" ? "chip-amber" : "border-moss/40 bg-moss/10 text-moss"}`}>
                      {ready.mode !== "hls" && <Zap size={10} className="mr-1 fill-current" />}
                      {methodLabel}
                    </span>
                  </p>
                  {ready.note && <p className="text-bone">{ready.note}</p>}
                  <p className="break-all">{ready.file.name}{ready.file.size > 0 && <> · {fmtSize(ready.file.size)}</>}</p>
                  {startMs !== null && <p>Started in {(startMs / 1000).toFixed(1)}s</p>}
                  <p>
                    {dev.label} · screen up to {dev.maxRes >= 2160 ? "4K" : `${dev.maxRes}p`} · {dev.hevc ? "HEVC" : "no HEVC"} · {dev.mse ? "browser remux available" : "no browser remux"} · {[dev.audio.ac3 && "AC-3", dev.audio.eac3 && "E-AC-3"].filter(Boolean).join(" + ") || "no Dolby audio"} · {dev.hdr ? "HDR display" : "SDR display"}
                  </p>
                </>
              }
              extra={
                showNext && p.next ? (
                  <div className="mb-3 flex justify-end">
                    <button onClick={p.onNext} className="btn-primary animate-rise shadow-lift">
                      <SkipForward size={16} className="fill-current" /> Next episode · E{p.next.episode}
                    </button>
                  </div>
                ) : null
              }
            />
          </MediaPlayer>
        )}

        {switching && (
          <div className="pointer-events-none absolute inset-x-0 top-4 z-30 mx-auto flex w-fit max-w-[92%] items-center gap-2.5 rounded-full border border-white/10 bg-black/70 px-4 py-2 text-xs text-bone backdrop-blur-md animate-rise">
            <Loader2 className="animate-spin" size={14} /> {switching}
          </div>
        )}
        {toast && <div className="absolute left-1/2 top-4 z-30 -translate-x-1/2 rounded-full border border-ember/40 bg-black/80 px-4 py-2 text-xs text-ember backdrop-blur-md">{toast}</div>}

        {(!ready || error) && (
          <div className="safe-t absolute inset-x-0 top-0 z-20 flex items-center justify-between p-[clamp(10px,2vw,22px)]">
            <button aria-label="Back" onClick={p.onBack} className="grid size-10 place-items-center rounded-full text-bone hover:bg-white/10">
              <ArrowLeft size={22} />
            </button>
            {p.actions}
          </div>
        )}
        {!ready && !error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-center">
            {bg && <img src={bg} alt="" className="absolute inset-0 -z-10 h-full w-full scale-110 object-cover opacity-30 blur-xl" />}
            <Loader2 className="animate-spin text-bone" size={34} />
            <p className="max-w-sm px-6 text-sm text-bone-dim">{status}</p>
            {waited >= 6 && <p className="max-w-sm px-6 text-xs text-bone-mute">{waited}s. Big 4K and HDR files take longer to prepare.</p>}
            {waited >= 16 && (
              <button className="btn-ghost !py-2 text-xs" onClick={() => p.onFail("Pick a lighter (1080p) source for a faster start.")}>
                Try a lighter source
              </button>
            )}
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink-950/90 px-6 text-center">
            <AlertTriangle className="text-ember" size={34} />
            <p className="max-w-md text-sm text-bone">{error}</p>
          </div>
        )}

      </div>

    </div>
  );
}
