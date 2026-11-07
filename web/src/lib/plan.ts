import type { PlayResult } from "../types";
import { canDirectPlay, containerNative, nativeAudio } from "./compat";
import { device } from "./device";
import { RemuxSession, RemuxUnsupported, remuxSupported } from "./remux";

/**
 * Decide HOW this device plays a file, from what is really inside it (not the release name):
 *
 *   direct  the browser plays the CDN file as-is (container, video and the audio track are all native here)
 *   remux   the browser repackages it live (video copied, audio copied or converted, any language switchable)
 *   hls     TorBox transcodes it (last resort: DTS/TrueHD-only files, Dolby Vision on non-Apple, unreadable files)
 */

export type Stage = "direct" | "remux" | "hls";
export interface Plan {
  stage: Stage;
  src?: string;
  session?: RemuxSession;
  /** Short human reason, shown under the player. */
  note: string;
}

const shortContainer = (mime: string) => (mime.includes("matroska") ? "mkv" : mime.includes("webm") ? "webm" : mime.includes("quicktime") ? "mov" : mime.includes("mp4") ? "mp4" : mime.includes("mp2t") ? "ts" : "");
const upper = (c: string) => ({ eac3: "E-AC-3", ac3: "AC-3", dtshd: "DTS-HD", truehd: "TrueHD" }[c] ?? c.toUpperCase());

async function openSession(sources: string[], startAt: number, lang: string): Promise<RemuxSession | null> {
  for (const src of sources) {
    const opening = RemuxSession.open(src, startAt, lang);
    const late = new Promise<null>((r) => setTimeout(() => r(null), 14000));
    try {
      const s = await Promise.race([opening, late]);
      if (s) return s;
      opening.then((x) => x.destroy()).catch(() => undefined); // answered after the deadline: discard
    } catch (e) {
      if (e instanceof RemuxUnsupported) throw e; // the file itself is the problem, another URL won't help
      // network or CORS trouble on this URL: try the same-origin proxy next
    }
  }
  return null;
}

export interface PlanOpts {
  /** Try the same-origin proxy before the CDN (used after the CDN failed). */
  preferProxy?: boolean;
  /** Skip "play as-is": it already failed at runtime. */
  forceRemux?: boolean;
}

export async function planFile(res: PlayResult, startAt: number, lang: string, opts: PlanOpts = {}): Promise<Plan> {
  const { preferProxy = false, forceRemux = false } = opts;
  const dv = device();
  const hints = res.hints;
  if (hints.hdr.includes("DV") && dv.browser !== "safari") return { stage: "hls", note: "Dolby Vision isn't supported on this device, so TorBox converts it" };

  const urls = [res.url, res.proxy].filter((u, i, a): u is string => !!u && a.indexOf(u) === i);
  const sources = preferProxy ? [...urls].reverse() : urls;

  if (!remuxSupported()) {
    const v = canDirectPlay(hints);
    return v.ok ? { stage: "direct", src: res.url, note: "" } : { stage: "hls", note: `${v.reason ?? "Not playable here"}, so TorBox converts it` };
  }

  let session: RemuxSession | null = null;
  try {
    session = await openSession(sources, startAt, lang);
  } catch (e) {
    return { stage: "hls", note: `${(e as Error).message}, so TorBox converts it` };
  }
  if (!session) {
    const v = canDirectPlay(hints);
    return v.ok ? { stage: "direct", src: res.url, note: "" } : { stage: "hls", note: "This file couldn't be read in the browser, so TorBox converts it" };
  }

  const cont = shortContainer(session.container);
  const aud = session.allAudio;
  const directOk =
    !forceRemux &&
    containerNative(cont) &&
    (aud.length === 0 ||
      (aud.length === 1
        ? nativeAudio(aud[0].codec)
        : dv.browser === "safari" && ["mp4", "mov"].includes(cont) && aud.every((a) => nativeAudio(a.codec))));
  if (directOk) {
    session.destroy();
    return { stage: "direct", src: res.url, note: "" };
  }

  if (aud.length === 0 || session.audios.length > 0) {
    const cur = session.audios[session.audioIndex];
    const skipped = aud.filter((a) => !a.decodable).length;
    const bits = [cur && !cur.copy ? `${upper(cur.codec)} audio converted for ${dv.label.split(" · ")[0]}` : "", skipped ? `${skipped} unsupported audio track${skipped > 1 ? "s" : ""} hidden` : ""].filter(Boolean);
    return { stage: "remux", session, src: session.src, note: bits.join(" · ") };
  }

  session.destroy();
  return { stage: "hls", note: `${aud.map((a) => upper(a.codec)).join(" / ")} audio can't play on ${dv.label.split(" · ")[0]}, so TorBox converts it` };
}
