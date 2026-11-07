import type { StreamItem } from "../types";
import { playPath } from "./compat";
import { device } from "./device";

/**
 * Re-order sources for THIS browser. The server ranks by quality; only the browser knows what it can
 * decode, so here "starts instantly" beats "looks biggest":
 *   1. cached sources before uncached
 *   2. files the browser can play directly or repackage itself (no transcode wait)
 *   3. otherwise, lighter TorBox transcodes first (<=1080p, SDR) because 4K HDR is the slowest for TorBox to prepare
 *   4. the server's own score breaks ties
 * Sources taller than the screen can use (4K on a phone) are pushed down: more bandwidth and decode work for no
 * visible gain. HEVC is preferred where the device has a hardware decoder (Apple, most modern Android).
 */
export function rankForBrowser(items: StreamItem[]): StreamItem[] {
  const key = (it: StreamItem) => {
    const path = playPath(it.release);
    const direct = path !== "hls";
    const r = it.release;
    const light = r.resolution <= 1080 && r.hdr.length === 0 ? 2 : r.resolution <= 1080 ? 1 : 0;
    const dv = device();
    const fits = r.resolution <= dv.maxRes ? 1 : 0; // never above what the screen can show
    const hdrOk = r.hdr.length === 0 || dv.hdr || dv.os === "ios" || dv.os === "mac" ? 1 : 0; // HDR on an SDR screen looks washed out
    return [it.cached ? 1 : 0, fits, path === "direct" ? 2 : path === "remux" ? 1 : 0, direct ? hdrOk : light, it.score];
  };
  return [...items].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
    return 0;
  });
}
