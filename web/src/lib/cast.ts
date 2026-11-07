/* Google Cast (Chromecast, Google TV, Cast-enabled TVs) via the Cast sender SDK and the Default Media Receiver.
   The TV fetches the file itself, so it needs a plain URL: the direct file or TorBox's HLS stream, never the
   in-browser remux. /api/media/* needs no cookie (the signed handle is the authorisation), so that works.
   Only Chromium browsers (Chrome, Edge, Android) can cast; elsewhere `castState` stays "unavailable". */

import { useEffect, useState } from "react";

/* eslint-disable @typescript-eslint/no-explicit-any */
// Untyped on purpose: the SDK is loaded at runtime and Vidstack's global Cast typings don't match this use.
const W = window as any;

export type CastState = "unavailable" | "idle" | "connecting" | "connected";

let loading: Promise<boolean> | null = null;
const listeners = new Set<() => void>();
let state: CastState = "unavailable";
let device = "";

function set(s: CastState) {
  if (s === state && (s !== "connected" || device)) return;
  state = s;
  listeners.forEach((f) => f());
}

function load(): Promise<boolean> {
  if (loading) return loading;
  const chromium = /Chrome|CriOS|Edg\//.test(navigator.userAgent) && !/Firefox|FxiOS/.test(navigator.userAgent);
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  if (!chromium || ios) return (loading = Promise.resolve(false));
  loading = new Promise((resolve) => {
    W.__onGCastApiAvailable = (ok: boolean) => {
      if (!ok || !W.cast?.framework) return resolve(false);
      const f = W.cast.framework;
      const ctx = f.CastContext.getInstance();
      ctx.setOptions({
        receiverApplicationId: W.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
        autoJoinPolicy: W.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
      });
      const sync = () => {
        const s = ctx.getCastState();
        device = ctx.getCurrentSession()?.getCastDevice()?.friendlyName ?? "";
        set(s === f.CastState.CONNECTED ? "connected" : s === f.CastState.CONNECTING ? "connecting" : s === f.CastState.NO_DEVICES_AVAILABLE ? "unavailable" : "idle");
      };
      ctx.addEventListener(f.CastContextEventType.CAST_STATE_CHANGED, sync);
      sync();
      resolve(true);
    };
    const s = document.createElement("script");
    s.src = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";
    s.async = true;
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
  return loading;
}

/** Live cast state and the connected device's name. Loads the SDK on first use. */
export function useCast(): { state: CastState; device: string } {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    listeners.add(f);
    void load();
    return () => void listeners.delete(f);
  }, []);
  return { state, device };
}

export interface CastMedia {
  url: string;
  mime: string;
  title: string;
  poster?: string;
  time: number;
}

/** Must be called straight from a click: Chrome only opens the device picker on a user gesture. */
export async function startCast(m: CastMedia): Promise<void> {
  const ctx = W.cast.framework.CastContext.getInstance();
  if (!ctx.getCurrentSession()) await ctx.requestSession();
  const c = W.chrome.cast.media;
  const info = new c.MediaInfo(new URL(m.url, location.href).href, m.mime);
  info.streamType = c.StreamType.BUFFERED;
  info.metadata = new c.MovieMediaMetadata();
  info.metadata.title = m.title;
  if (m.poster) info.metadata.images = [new W.chrome.cast.Image(new URL(m.poster, location.href).href)];
  const req = new c.LoadRequest(info);
  req.currentTime = m.time;
  req.autoplay = true;
  await ctx.getCurrentSession().loadMedia(req);
}

/** Position on the TV, so playback can carry on here at the same spot. */
export function castTime(): number {
  return W.cast?.framework.CastContext.getInstance().getCurrentSession()?.getMediaSession()?.getEstimatedTime() ?? 0;
}

export function castToggle(): void {
  const media = W.cast?.framework.CastContext.getInstance().getCurrentSession()?.getMediaSession();
  if (!media) return;
  const c = W.chrome.cast.media;
  if (media.playerState === c.PlayerState.PAUSED) media.play(new c.PlayRequest());
  else media.pause(new c.PauseRequest());
}

export function castPaused(): boolean {
  const media = W.cast?.framework.CastContext.getInstance().getCurrentSession()?.getMediaSession();
  return media?.playerState === W.chrome?.cast.media.PlayerState.PAUSED;
}

export function stopCast(): void {
  W.cast?.framework.CastContext.getInstance().endCurrentSession(true);
}
