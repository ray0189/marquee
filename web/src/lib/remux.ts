/**
 * Browser-side remux: read the original file straight from the CDN (HTTP range requests), copy the video
 * packets untouched into fragmented MP4 and feed them to the <video> through Media Source Extensions.
 * Audio is copied when the browser can play it, otherwise converted to AAC locally (AC-3/E-AC-3 included).
 * No server is involved and nothing is re-encoded, so a 4K HEVC .mkv starts in a second or two.
 *
 * Seeking outside the buffered range restarts the conversion at that time; switching audio does the same
 * at the current time, which is why it is instant and needs no new TorBox stream.
 */
import type { Conversion, Input, InputAudioTrack } from "mediabunny";
import { isManagedMse, msConstructor } from "./device";

export class RemuxUnsupported extends Error {}

export interface RemuxAudio {
  index: number;
  label: string;
  lang: string;
  codec: string;
  copy: boolean; // false => converted in the browser (see `out`)
  out: "aac" | "flac" | null; // codec used when converting
}

const COPY_OK = new Set(["aac", "mp3", "opus", "flac"]);
const BUFFER_AHEAD = 80; // seconds to keep converted ahead of the playhead
const BUFFER_BEHIND = 40;

/** Desktop and Android: MediaSource. iPhone (iOS 17.1+): ManagedMediaSource, same idea with the OS in charge of buffering. */
export const remuxSupported = () => {
  const M = msConstructor();
  return !!M && typeof M.isTypeSupported === "function" && typeof Worker !== "undefined";
};
const msTypeOk = (t: string) => !!msConstructor()?.isTypeSupported(t);

/** Start loading the conversion code before it's needed (called when the watch page opens). */
// Track names that mean "the original / English" in the languages release groups commonly label in.
const ORIGINAL = /\b(original|orig)\b|оригинал|originale/i;
const ENGLISH = /\benglish\b|\beng\b|английск|anglais|inglés|englisch/i;

/** How well a track fits the viewer: a matching language tag first, then names that say so, since many releases
 *  tag every track with the release's language or leave them untagged. */
export function audioScore(a: { lang: string; label: string }, preferredLang: string): number {
  const want = preferredLang.slice(0, 2);
  const tag = a.lang ? langIso3to2(a.lang) || a.lang.slice(0, 2) : "";
  let s = 0;
  if (tag === want) s += 4;
  if (want === "en" && ENGLISH.test(a.label)) s += 5; // the name beats a wrong tag
  if (ORIGINAL.test(a.label)) s += 2;
  if (/commentary|комментар/i.test(a.label)) s -= 6;
  return s;
}

export function warmRemux() {
  if (!remuxSupported()) return;
  void import("mediabunny").catch(() => undefined);
  // The AC-3 decoder (~1.2 MB) is fetched in open() only when a file actually has AC-3 audio; preloading it
  // here made every play on Chrome/Firefox download it while competing with the first video bytes.
}

export interface TrackInfo {
  codec: string;
  lang: string;
  label: string;
  decodable: boolean;
}

const OUT_CPS = { aac: "mp4a.40.2", flac: "flac" } as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class RemuxSession {
  readonly url: string;
  duration = 0;
  /** What the file really contains (not what the release name says). */
  container = "";
  videoCodecString = "";
  allAudio: TrackInfo[] = [];
  audios: RemuxAudio[] = [];
  audioIndex = 0;
  onError: (e: unknown) => void = () => undefined;
  onAudioSwitched: () => void = () => undefined;

  private mse = new (msConstructor()!)();
  private sb: SourceBuffer | null = null;
  private video: HTMLVideoElement | null = null;
  private gen = 0;
  private conversion: Conversion | null = null;
  private chain: Promise<void> = Promise.resolve();
  private dead = false;
  private videoCodec = "";
  private mb!: typeof import("mediabunny");
  private input!: Input;
  private tracks: InputAudioTrack[] = [];
  private opening = false;
  private pendingSeek: number | null = null;
  /** Bytes pushed into the player so far: lets the watchdog tell "slow" from "stuck". */
  appended = 0;

  private constructor(readonly src: string, private startAt: number) {
    this.url = URL.createObjectURL(this.mse);
  }

  /** Probe the file. Throws RemuxUnsupported when this browser can't play the video track without re-encoding. */
  static async open(src: string, startAt: number, preferredLang: string): Promise<RemuxSession> {
    if (!remuxSupported()) throw new RemuxUnsupported("No Media Source support");
    const s = new RemuxSession(src, startAt);
    try {
      await s.probe(preferredLang);
    } catch (e) {
      s.destroy();
      throw e;
    }
    return s;
  }

  private async probe(preferredLang: string) {
    const mb = (this.mb = await import("mediabunny"));
    this.input = new mb.Input({
      source: new mb.UrlSource(this.src, { parallelism: 6, maxCacheSize: 160 * 1024 * 1024, getRetryDelay: (n) => (n < 3 ? 0.8 : null) }),
      formats: mb.ALL_FORMATS,
    });
    const v = await this.input.getPrimaryVideoTrack();
    if (!v) throw new RemuxUnsupported("No video track");
    this.videoCodec = (await v.getCodecParameterString()) ?? "";
    this.videoCodecString = this.videoCodec;
    this.container = (await this.input.getMimeType().catch(() => "")).split(";")[0].trim();
    if (!this.videoCodec || !msTypeOk(`video/mp4; codecs="${this.videoCodec}"`)) throw new RemuxUnsupported(`Video codec ${this.videoCodec || "?"} not playable here`);

    this.duration = (await this.input.getDurationFromMetadata()) ?? (await this.input.computeDuration());

    this.tracks = await this.input.getAudioTracks();
    // Inspect every track at once: one round of metadata reads instead of one per track.
    const meta = await Promise.all(this.tracks.map(async (t) => ({ codec: (await t.getCodec()) ?? "", cps: (await t.getCodecParameterString()) ?? "" })));
    const copyable = meta.map((m) => COPY_OK.has(m.codec) && !!m.cps && msTypeOk(`audio/mp4; codecs="${m.cps}"`));
    if (meta.some((m, i) => !copyable[i] && (m.codec === "ac3" || m.codec === "eac3"))) {
      (await import("@mediabunny/ac3")).registerAc3Decoder();
    }
    const decodable = await Promise.all(this.tracks.map((t, i) => (copyable[i] ? Promise.resolve(true) : t.canDecode().catch(() => false))));
    const encoder = decodable.some((d, i) => d && !copyable[i]) ? await this.pickEncoder() : null;
    for (const [i, t] of this.tracks.entries()) {
      const { codec } = meta[i];
      const copy = copyable[i];
      const out: RemuxAudio["out"] = copy ? null : decodable[i] ? encoder : null;
      const ok = copy || (decodable[i] && !!out);
      console.debug("[marquee] remux audio", i, codec, { copy, dec: decodable[i], out });
      const label = t.name || (t.languageCode && t.languageCode !== "und" ? t.languageCode.toUpperCase() : `Track ${i + 1}`);
      this.allAudio.push({ codec, lang: t.languageCode || "", label, decodable: ok });
      if (!ok) continue; // DTS / TrueHD and friends can't be turned into anything a browser plays
      this.audios.push({ index: i, label, lang: t.languageCode || "", codec, copy, out });
    }
    const best = this.audios.reduce((bi, a, i, all) => (audioScore(a, preferredLang) > audioScore(all[bi], preferredLang) ? i : bi), 0);
    this.audioIndex = this.audios.length ? best : 0;
  }

  /** AAC when the browser has an encoder, else FLAC through a small WASM encoder (works everywhere). */
  private encoder: RemuxAudio["out"] | undefined;
  private async pickEncoder(): Promise<RemuxAudio["out"]> {
    if (this.encoder !== undefined) return this.encoder;
    const mb = this.mb;
    const forced = (globalThis as { __mqEnc?: string }).__mqEnc;
    if (forced === "flac") {
      (await import("@mediabunny/flac-encoder")).registerFlacEncoder();
      return (this.encoder = "flac");
    }
    const has = typeof AudioEncoder !== "undefined";
    if (has && (await mb.canEncodeAudio("aac").catch(() => false)) && msTypeOk('audio/mp4; codecs="mp4a.40.2"')) return (this.encoder = "aac");
    if (msTypeOk('audio/mp4; codecs="flac"')) {
      (await import("@mediabunny/flac-encoder")).registerFlacEncoder();
      return (this.encoder = "flac");
    }
    return (this.encoder = null);
  }

  /** Wire up the <video> that is playing this session's object URL. */
  bind(video: HTMLVideoElement) {
    this.video = video;
    if (isManagedMse()) video.disableRemotePlayback = true; // required by ManagedMediaSource (iOS) unless an AirPlay source is given
    const open = () => void this.begin(this.startAt).catch((e) => this.fail(e));
    if (this.mse.readyState === "open") open();
    else this.mse.addEventListener("sourceopen", open, { once: true });
    video.addEventListener("seeking", this.onSeeking);
    video.addEventListener("timeupdate", this.onTime);
  }

  private onSeeking = () => {
    const v = this.video;
    if (!v || !this.sb) return;
    if (!this.buffered(v.currentTime)) this.seekTo(v.currentTime);
  };
  /** Seeks that land while another is still starting used to be dropped (begin() bails while opening), leaving
   *  the player waiting on a spot nothing converts until the stall watchdog fired. Keep only the latest target
   *  and run it as soon as the current start finishes. */
  private wantAt: number | null = null;
  private seeking = false;
  private seekTo(t: number) {
    this.wantAt = t;
    if (this.seeking) return;
    this.seeking = true;
    void (async () => {
      try {
        while (this.wantAt !== null && !this.dead) {
          const at = this.wantAt;
          this.wantAt = null;
          if (this.buffered(at)) continue; // a later conversion already covers it
          await this.restart(at);
        }
      } catch (e) {
        this.fail(e);
      } finally {
        this.seeking = false;
      }
    })();
  }
  private lastTrim = 0;
  private onTime = () => {
    const v = this.video;
    if (!v || !this.sb || this.sb.updating || v.currentTime - this.lastTrim < 20) return;
    this.lastTrim = v.currentTime;
    const cut = v.currentTime - BUFFER_BEHIND;
    if (cut > 1) this.chain = this.chain.then(() => this.removeRange(0, cut)).catch(() => undefined);
  };

  private buffered(t: number): boolean {
    const b = this.video?.buffered;
    if (!b) return false;
    for (let i = 0; i < b.length; i++) if (t >= b.start(i) - 0.05 && t <= b.end(i) - 0.5) return true;
    return false;
  }
  private bufferedAhead(): number {
    const v = this.video;
    if (!v) return 0;
    for (let i = 0; i < v.buffered.length; i++) if (v.currentTime >= v.buffered.start(i) - 0.05 && v.currentTime <= v.buffered.end(i)) return v.buffered.end(i) - v.currentTime;
    return 0;
  }

  async switchAudio(i: number) {
    if (i === this.audioIndex || !this.audios[i]) return;
    this.audioIndex = i;
    await this.restart(this.video?.currentTime ?? 0);
    this.onAudioSwitched();
  }

  private async restart(at: number) {
    this.gen++;
    await this.stopConversion();
    await this.begin(at);
  }

  private async stopConversion() {
    const c = this.conversion;
    this.conversion = null;
    await c?.cancel().catch(() => undefined);
    await this.chain.catch(() => undefined);
  }

  private mimeFor(a: RemuxAudio | undefined): string {
    return `video/mp4; codecs="${this.videoCodec}${a ? `,${a.copy ? this.audioCps(a) : OUT_CPS[a.out!]}` : ""}"`;
  }
  private audioCpsCache = new Map<number, string>();
  private audioCps(a: RemuxAudio) {
    return this.audioCpsCache.get(a.index) ?? "mp4a.40.2";
  }

  private async begin(at: number) {
    if (this.dead || this.opening) return;
    this.opening = true;
    try {
      const gen = ++this.gen;
      const mb = this.mb;
      const audio = this.audios[this.audioIndex];
      if (audio?.copy && !this.audioCpsCache.has(audio.index)) this.audioCpsCache.set(audio.index, (await this.tracks[audio.index].getCodecParameterString()) ?? "mp4a.40.2");
      const start = Math.max(0, Math.min(at, Math.max(0, this.duration - 1)));

      if (!this.sb) {
        this.sb = this.mse.addSourceBuffer(this.mimeFor(audio));
        this.sb.mode = "segments";
        this.mse.duration = this.duration;
      } else {
        await this.idle();
        if (this.mse.readyState === "open") this.sb.abort();
        await this.removeRange(0, Infinity);
        const mime = this.mimeFor(audio);
        if (typeof this.sb.changeType === "function") this.sb.changeType(mime);
        else {
          this.mse.removeSourceBuffer(this.sb); // browsers without changeType: start a fresh buffer instead
          this.sb = this.mse.addSourceBuffer(mime);
          this.sb.mode = "segments";
        }
      }
      this.sb.timestampOffset = start;
      this.pendingSeek = start > 0.5 ? start : null;
      this.lastTrim = 0;

      const output = new mb.Output({
        format: new mb.Mp4OutputFormat({ fastStart: "fragmented", minimumFragmentDuration: 1 }),
        target: new mb.StreamTarget(new WritableStream({ write: (chunk) => this.push(gen, chunk.data) }), { chunked: false }),
      });
      const wanted = audio ? this.tracks[audio.index] : null;
      const conversion = await mb.Conversion.init({
        input: this.input,
        output,
        trim: { start },
        video: { forceTranscode: false },
        audio: (t: InputAudioTrack) => (wanted && t === wanted ? (audio!.copy ? {} : { codec: audio!.out!, ...(audio!.out === "flac" ? { sampleFormat: "s16" as const } : {}) }) : { discard: true }),
        subtitle: { discard: true },
        showWarnings: false,
      } as never);
      if (!conversion.isValid) throw new RemuxUnsupported("Conversion not possible in this browser");
      this.conversion = conversion;
      void this.pump(gen, conversion, start);
    } finally {
      this.opening = false;
    }
  }

  /** Convert in 20 s steps, pausing while enough is buffered ahead of the playhead. */
  private async pump(gen: number, c: Conversion, start: number) {
    try {
      // Start small so the first picture appears fast (a 4K remux is ~10 MB per second of film), then grow.
      let until = 0;
      let step = 2;
      for (;;) {
        if (this.dead || gen !== this.gen) return;
        if (this.bufferedAhead() > BUFFER_AHEAD) {
          await sleep(400);
          continue;
        }
        until += step;
        step = Math.min(20, Math.ceil(step * 2));
        await c.execute({ until });
        if (c.state === "done" || until > this.duration - start + 30) break;
      }
      await this.chain;
      if (!this.dead && gen === this.gen && this.mse.readyState === "open") this.mse.endOfStream();
    } catch (e) {
      if (!this.dead && gen === this.gen && !String((e as Error)?.name).includes("Cancel")) this.fail(e);
    }
  }

  // --- SourceBuffer plumbing ---------------------------------------------------------------

  private push(gen: number, data: Uint8Array): Promise<void> {
    if (gen !== this.gen || this.dead) return Promise.resolve();
    const copy = new Uint8Array(data); // the muxer may reuse its buffer
    this.chain = this.chain.then(() => (gen === this.gen && !this.dead ? this.append(copy) : undefined));
    return this.chain;
  }

  private idle(): Promise<void> {
    const sb = this.sb;
    if (!sb || !sb.updating) return Promise.resolve();
    return new Promise((r) => sb.addEventListener("updateend", () => r(), { once: true }));
  }

  private async append(data: Uint8Array, retry = true): Promise<void> {
    const sb = this.sb!;
    this.appended += data.byteLength;
    await this.idle();
    try {
      await new Promise<void>((res, rej) => {
        sb.addEventListener("updateend", () => res(), { once: true });
        sb.addEventListener("error", () => rej(new Error("SourceBuffer error")), { once: true });
        sb.appendBuffer(data as BufferSource as ArrayBuffer);
      });
    } catch (e) {
      if (retry && (e as DOMException)?.name === "QuotaExceededError") {
        const t = this.video?.currentTime ?? 0;
        await this.removeRange(0, Math.max(0, t - 10));
        return this.append(data, false);
      }
      throw e;
    }
    const v = this.video;
    if (v && this.pendingSeek !== null && v.buffered.length && this.pendingSeek >= v.buffered.start(0) - 0.1) {
      const t = this.pendingSeek;
      this.pendingSeek = null;
      if (Math.abs(v.currentTime - t) > 0.3) v.currentTime = t;
    }
  }

  private async removeRange(from: number, to: number) {
    const sb = this.sb;
    if (!sb || this.mse.readyState !== "open") return;
    await this.idle();
    await new Promise<void>((res) => {
      sb.addEventListener("updateend", () => res(), { once: true });
      try {
        sb.remove(from, to);
      } catch {
        res();
      }
    });
  }

  private fail(e: unknown) {
    if (this.dead) return;
    console.error("[marquee] remux error", e);
    this.onError(e);
  }

  destroy() {
    this.dead = true;
    this.gen++;
    this.video?.removeEventListener("seeking", this.onSeeking);
    this.video?.removeEventListener("timeupdate", this.onTime);
    void this.conversion?.cancel().catch(() => undefined);
    try {
      this.input?.dispose();
    } catch {
      /* already disposed */
    }
    URL.revokeObjectURL(this.url);
  }
}

const ISO3: Record<string, string> = { eng: "en", ita: "it", fra: "fr", fre: "fr", deu: "de", ger: "de", spa: "es", por: "pt", rus: "ru", jpn: "ja", kor: "ko", zho: "zh", chi: "zh", ara: "ar", hin: "hi", nld: "nl", dut: "nl", pol: "pl", tur: "tr", swe: "sv" };
const langIso3to2 = (l: string) => ISO3[l.toLowerCase()] ?? l.slice(0, 2).toLowerCase();
