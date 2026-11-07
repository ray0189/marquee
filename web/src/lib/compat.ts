import type { Release } from "../types";
import { device, supports } from "./device";
import { remuxSupported } from "./remux";

/**
 * Can THIS device play the file straight from the CDN? Anything it can't is repackaged in the browser
 * (remux.ts) or, as the last resort, transcoded by TorBox. The server never makes this call: only the
 * device knows what it can decode. These checks work from the release name (before any download starts);
 * the player then confirms them against the real tracks inside the file.
 */

const d = () => device();
export const isSafari = typeof navigator !== "undefined" && /Safari\//.test(navigator.userAgent) && !/Chrome\/|Chromium\/|Edg\/|CriOS|FxiOS/.test(navigator.userAgent);
const chromiumEngine = () => ["chrome", "edge", "samsung"].includes(d().browser) && d().os !== "ios";

export interface Verdict {
  ok: boolean;
  reason?: string;
}

/** Is this container (as reported by mediabunny or the file name) playable natively here? */
export function containerNative(container: string): boolean {
  const c = container.toLowerCase();
  if (["mp4", "m4v", "mov", "m4a"].includes(c)) return true;
  if (c === "webm") return d().browser !== "safari" && d().os !== "ios";
  if (["mkv", "matroska", ""].includes(c)) return chromiumEngine();
  return false;
}

/** Is an audio codec (mediabunny names) playable natively on this device inside MP4/MKV? */
export function nativeAudio(codec: string): boolean {
  const a = d().audio;
  switch (codec) {
    case "aac":
      return a.aac;
    case "mp3":
      return a.mp3;
    case "opus":
      return a.opus;
    case "flac":
      return a.flac;
    case "ac3":
      return a.ac3;
    case "eac3":
      return a.eac3;
    case "vorbis":
      return d().browser !== "safari" && d().os !== "ios";
    default:
      return false;
  }
}

export function canDirectPlay(r: Release): Verdict {
  const dv = d();
  const c = r.container;
  if (["avi", "wmv", "ts", "m2ts", "mpg", "mpeg"].includes(c)) return { ok: false, reason: `${c.toUpperCase()} container` };
  if (!containerNative(c)) return { ok: false, reason: c === "webm" ? "WebM" : "Matroska isn't played natively here" };

  if (r.codec === "mpeg4" || r.codec === "vc1") return { ok: false, reason: "Old video codec" };
  if (r.codec === "hevc" && !dv.hevc) return { ok: false, reason: "HEVC unsupported" };
  if (r.codec === "av1" && !dv.av1) return { ok: false, reason: "AV1 unsupported" };
  if (r.hdr.includes("DV") && dv.browser !== "safari") return { ok: false, reason: "Dolby Vision" };

  if (r.audio.some((a) => ["dts", "dtshd", "dtsx", "truehd"].includes(a))) return { ok: false, reason: "DTS/TrueHD audio" };
  const only = r.audio.filter((a) => a !== "atmos");
  if (only.length && !only.some((a) => nativeAudio(a))) return { ok: false, reason: "This audio format isn't supported here" };
  // Several languages in one file: a plain <video> can't switch them (only Safari exposes the tracks), so the
  // browser-side remux takes over, which can.
  if (r.audio.length > 1 && !(dv.browser === "safari" && ["mp4", "m4v", "mov"].includes(c))) return { ok: false, reason: "Multiple audio tracks" };
  return { ok: true };
}

/**
 * Could the device repackage this file itself (see remux.ts)? That removes the container and audio limits
 * without any server work: video must be decodable as-is, and at least one audio track must be something we can
 * copy or convert (DTS and TrueHD can't be).
 */
export function remuxLikely(r: Release): boolean {
  const dv = d();
  if (!remuxSupported()) return false;
  if (!["mkv", "mp4", "m4v", "mov", "webm", "ts", "m2ts", ""].includes(r.container)) return false;
  if (r.codec === "mpeg4" || r.codec === "vc1") return false;
  if (r.codec === "hevc" && !dv.hevc) return false;
  if (r.codec === "av1" && !dv.av1) return false;
  if (r.hdr.includes("DV") && dv.browser !== "safari") return false;
  if (r.audio.length && r.audio.every((a) => ["dts", "dtshd", "dtsx", "truehd"].includes(a))) return false;
  return true;
}

export type PlayPath = "direct" | "remux" | "hls";
export const playPath = (r: Release): PlayPath => (canDirectPlay(r).ok ? "direct" : remuxLikely(r) ? "remux" : "hls");

/** Video codec string playable here? (used on real codec strings from the file) */
export const videoPlayable = (codecString: string) => !!codecString && supports(`video/mp4; codecs="${codecString}"`);
