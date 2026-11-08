/* Volume boost above 100% through Web Audio: video -> gain -> limiter -> speakers.

   Routing a <video> into Web Audio is permanent for that element, and for a cross-origin file the browser
   wasn't given CORS access to, it outputs silence. So the graph is only built when the source is safe
   (same-origin, a MediaSource blob from the browser remux, or fetched with crossOrigin) and only once the
   viewer actually pushes past 100%. */

interface Graph {
  ctx: AudioContext;
  gain: GainNode;
}

const graphs = new WeakMap<HTMLMediaElement, Graph>();

export function canBoost(video: HTMLMediaElement | null | undefined): boolean {
  if (!video || typeof AudioContext === "undefined") return false;
  const src = video.currentSrc || video.src;
  if (!src) return false;
  if (src.startsWith("blob:")) return true; // browser remux (MSE): same-origin by construction
  try {
    return new URL(src, location.href).origin === location.origin || !!video.crossOrigin;
  } catch {
    return false;
  }
}

/** Set the boost factor (1 = off, up to 2 = 200%). Call from a user gesture the first time (autoplay rules). */
export function setBoost(video: HTMLMediaElement, factor: number): boolean {
  let g = graphs.get(video);
  if (!g) {
    if (factor <= 1 || !canBoost(video)) return false;
    const ctx = new AudioContext();
    const source = ctx.createMediaElementSource(video);
    const gain = ctx.createGain();
    // A limiter, so boosted peaks are squashed instead of clipping into distortion.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    source.connect(gain).connect(limiter).connect(ctx.destination);
    g = { ctx, gain };
    graphs.set(video, g);
    // Once the video's sound runs through Web Audio, Chromium paces the video by it: a suspended context (after a
    // seek, a tab switch, a device change) leaves the picture frozen with plenty buffered. Keep it running.
    const wake = () => {
      if (ctx.state === "suspended" && !video.paused) void ctx.resume();
    };
    ctx.addEventListener("statechange", wake);
    for (const ev of ["play", "playing", "seeked", "waiting"]) video.addEventListener(ev, wake);
  }
  if (g.ctx.state === "suspended") void g.ctx.resume();
  g.gain.gain.setTargetAtTime(Math.max(1, Math.min(2, factor)), g.ctx.currentTime, 0.02);
  return true;
}

/** Resume a boosted video's audio engine if it was suspended (a frozen picture with data buffered). */
export function wakeBoost(video: HTMLMediaElement): void {
  const g = graphs.get(video);
  if (g && g.ctx.state === "suspended") void g.ctx.resume();
}

/** For diagnostics: is this video's sound running through the boost, and what state is its audio engine in? */
export function boostOn(video: HTMLMediaElement): boolean {
  return graphs.has(video);
}
export function boostState(video: HTMLMediaElement): string {
  return graphs.get(video)?.ctx.state ?? "";
}
