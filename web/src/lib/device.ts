/**
 * What is this device, and what can it actually decode? Everything the player and the source ranking decide
 * is based on this profile, measured in the browser (never guessed from the server), so the same invite link
 * picks the right method on an iPhone, an Android phone, a laptop or a TV browser.
 */

export type OS = "ios" | "android" | "mac" | "windows" | "linux" | "other";
export type Kind = "phone" | "tablet" | "desktop" | "tv";
export type Browser = "safari" | "chrome" | "edge" | "firefox" | "samsung" | "other";

export interface Device {
  os: OS;
  kind: Kind;
  browser: Browser;
  /** Media Source Extensions (iPhone only has the "managed" flavour, iOS 17.1+). */
  mse: boolean;
  nativeHls: boolean;
  hevc: boolean;
  av1: boolean;
  /** Natively playable audio inside MP4/MSE. */
  audio: { aac: boolean; ac3: boolean; eac3: boolean; opus: boolean; flac: boolean; mp3: boolean };
  hdr: boolean;
  /** Tallest picture worth sending to this screen (source height). */
  maxRes: number;
  saveData: boolean;
  /** One line for the UI, e.g. "iPhone · Safari". */
  label: string;
}

let probe: HTMLVideoElement | null = null;
const can = (type: string): boolean => {
  if (typeof document === "undefined") return false;
  probe ??= document.createElement("video");
  return probe.canPlayType(type) !== "";
};
const mseOk = (type: string): boolean => {
  const M = msConstructor();
  return !!M && M.isTypeSupported(type);
};

export function msConstructor(): typeof MediaSource | undefined {
  const g = globalThis as unknown as { ManagedMediaSource?: typeof MediaSource; MediaSource?: typeof MediaSource };
  return g.ManagedMediaSource ?? g.MediaSource;
}
export const isManagedMse = () => !!(globalThis as unknown as { ManagedMediaSource?: unknown }).ManagedMediaSource && !(globalThis as unknown as { MediaSource?: unknown }).MediaSource;

/** Can this browser play this exact codec string (video or audio) in MP4, by either route? */
export const supports = (mime: string): boolean => can(mime) || mseOk(mime);

function detect(): Device {
  const nav = typeof navigator === "undefined" ? ({} as Navigator) : navigator;
  const ua = nav.userAgent ?? "";
  const touch = (nav.maxTouchPoints ?? 0) > 1;
  const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && touch);
  const ios = /iPhone|iPod/.test(ua) || ipad;
  const android = /Android/.test(ua);
  const os: OS = ios ? "ios" : android ? "android" : /Mac OS X|Macintosh/.test(ua) ? "mac" : /Windows/.test(ua) ? "windows" : /Linux|CrOS/.test(ua) ? "linux" : "other";

  const tv = /SMART-TV|SmartTV|Tizen|Web0S|webOS|AFT|BRAVIA|CrKey|HbbTV|Roku|AppleTV/i.test(ua);
  const w = Math.min(screen?.width ?? 1280, screen?.height ?? 720);
  const kind: Kind = tv ? "tv" : ipad || (android && w >= 600 && !/Mobile/.test(ua)) ? "tablet" : ios || (android && /Mobile/.test(ua)) ? "phone" : "desktop";

  const browser: Browser = /SamsungBrowser/.test(ua) ? "samsung" : /Edg\//.test(ua) ? "edge" : /Firefox\/|FxiOS/.test(ua) ? "firefox" : /Chrome\/|CriOS|Chromium/.test(ua) ? "chrome" : /Safari\//.test(ua) ? "safari" : "other";

  const mse = !!msConstructor();
  const nativeHls = can("application/vnd.apple.mpegurl") || can("application/x-mpegURL");
  const hevc = supports('video/mp4; codecs="hvc1.1.6.L120.90"') || supports('video/mp4; codecs="hev1.1.6.L120.90"');
  const av1 = supports('video/mp4; codecs="av01.0.08M.08"');
  const audio = {
    aac: supports('audio/mp4; codecs="mp4a.40.2"'),
    ac3: supports('audio/mp4; codecs="ac-3"'),
    eac3: supports('audio/mp4; codecs="ec-3"'),
    opus: supports('audio/mp4; codecs="opus"'),
    flac: supports('audio/mp4; codecs="flac"'),
    mp3: supports('audio/mp4; codecs="mp3"') || can("audio/mpeg"),
  };
  const hdr = typeof matchMedia === "function" && matchMedia("(dynamic-range: high)").matches;

  const dpr = Math.min(typeof devicePixelRatio === "number" ? devicePixelRatio : 1, 3);
  const px = Math.max(screen?.width ?? 1280, screen?.height ?? 720) * dpr; // long edge
  const screenRes = px >= 3400 ? 2160 : px >= 2300 ? 1440 : px >= 1700 ? 1080 : 720;
  const conn = (nav as Navigator & { connection?: { saveData?: boolean } }).connection;
  const saveData = !!conn?.saveData;
  // Phones watch 1080p at most: a 4K file is pure bandwidth and decode cost there.
  const maxRes = saveData ? 720 : kind === "phone" ? 1080 : kind === "tablet" ? Math.min(screenRes, 1440) : screenRes;

  const name = ios ? (ipad ? "iPad" : "iPhone") : android ? (kind === "tablet" ? "Android tablet" : "Android phone") : os === "mac" ? "Mac" : os === "windows" ? "Windows PC" : os === "linux" ? "Linux" : "Browser";
  const br = { safari: "Safari", chrome: "Chrome", edge: "Edge", firefox: "Firefox", samsung: "Samsung Internet", other: "" }[browser];
  return { os, kind, browser, mse, nativeHls, hevc, av1, audio, hdr, maxRes, saveData, label: [name, br].filter(Boolean).join(" · ") };
}

let cached: Device | null = null;
export const device = (): Device => (cached ??= detect());
