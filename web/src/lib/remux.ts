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
  channels: number; // of the source track; 7.1 (TrueHD/Atmos, DTS-HD MA) is mixed down when converted
}

const COPY_OK = new Set(["aac", "mp3", "opus", "flac"]);
// How far ahead to keep converted: as much as fits in a memory budget at this file's real bitrate, between
// 1 and 10 minutes (about 5 minutes of a typical 1080p WEB file, about 1 minute of a 4K remux). Browsers cap
// what a page may hold for MSE playback (~150 MB of video in Chrome), and phones less, so it's bytes that
// matter, not seconds.
const BUFFER_MIN = 60;
const BUFFER_MAX = 600;
const MEM_BUDGET = (/iPhone|iPad|Android/i.test(navigator.userAgent) ? 80 : 140) * 1024 * 1024;
const BUFFER_BEHIND = 30;

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
  private video: HTMLVideoElement | null = null;
  private gen = 0;
  private dead = false;
  private videoCodec = "";
  private mb!: typeof import("mediabunny");
  private input!: Input;
  private tracks: InputAudioTrack[] = [];
  private opening = false;
  private pendingSeek: number | null = null;
  /** One lane (audio and video together) normally. Files with DTS/TrueHD audio get two lanes (video, audio), each
   *  with its own SourceBuffer, so the copied video never waits on audio converted on the device. */
  private lanes: Lane[] = [];
  /** Bytes pushed into the player so far: lets the watchdog tell "slow" from "stuck". */
  get appended() {
    return this.lanes.reduce((n, l) => n + l.appended, 0);
  }

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
    // On-device decoders, each fetched only when a film actually has that audio (~1-4 MB of WebAssembly each):
    // Dolby Digital (AC-3/E-AC-3), DTS (incl. DTS-HD core) and Dolby TrueHD. The video is still copied untouched;
    // only the audio is converted, which is light work even on a phone, instead of TorBox's full transcode.
    const need = (c: string) => meta.some((m, i) => !copyable[i] && m.codec === c);
    await Promise.all([
      need("ac3") || need("eac3") ? import("@mediabunny/ac3").then((m) => m.registerAc3Decoder()) : null,
      need("dts") ? import("@mediabunny/dts").then((m) => m.registerDtsDecoder()) : null,
      need("truehd") ? import("@mediabunny/truehd").then((m) => m.registerTrueHdDecoder()) : null,
    ]);
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
      if (!ok) continue; // nothing here can decode it (an unusual codec, or the decoder failed to load)
      this.audios.push({ index: i, label, lang: t.languageCode || "", codec, copy, out, channels: t.numberOfChannels || 2 });
    }
    const best = this.audios.reduce((bi, a, i, all) => (audioScore(a, preferredLang) > audioScore(all[bi], preferredLang) ? i : bi), 0);
    this.audioIndex = this.audios.length ? best : 0;
    // Split lanes when any track is decoded on the device with a decoder that hands audio back more slowly than
    // the copied video arrives (DTS, TrueHD): one combined stream made the video wait for it (90 s chunks).
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
    if (!v || !this.lanes.length) return;
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
    if (!v || !this.lanes.length || v.currentTime - this.lastTrim < 20) return;
    this.lastTrim = v.currentTime;
    const cut = v.currentTime - BUFFER_BEHIND;
    if (cut > 1) for (const l of this.lanes) if (l.sb && !l.sb.updating) l.chain = l.chain.then(() => this.removeRange(l, 0, cut)).catch(() => undefined);
  };

  /** Playable at t: every lane has data there (the <video> reports the overlap of all its buffers). */
  private buffered(t: number): boolean {
    const b = this.video?.buffered;
    if (!b) return false;
    for (let i = 0; i < b.length; i++) if (t >= b.start(i) - 0.05 && t <= b.end(i) - 0.5) return true;
    return false;
  }
  private laneAhead(l: Lane): number {
    const v = this.video;
    const b = l.sb?.buffered;
    if (!v || !b) return 0;
    for (let i = 0; i < b.length; i++) if (v.currentTime >= b.start(i) - 0.05 && v.currentTime <= b.end(i)) return b.end(i) - v.currentTime;
    return 0;
  }

  async switchAudio(i: number) {
    if (i === this.audioIndex || !this.audios[i]) return;
    this.audioIndex = i;
    const at = this.video?.currentTime ?? 0;
    if (this.lanes[1]) await this.restartLane(this.lanes[1], at); // the picture keeps playing; only the sound restarts
    else await this.restart(at);
    this.onAudioSwitched();
  }

  private async restart(at: number) {
    this.gen++;
    for (const l of this.lanes) await this.stopLane(l);
    await this.begin(at);
  }

  private async stopLane(l: Lane) {
    l.gen++;
    const c = l.conversion;
    const stop = l.stop;
    l.conversion = null;
    l.stop = null;
    await (stop ? stop() : c?.cancel())?.catch(() => undefined);
    await l.chain.catch(() => undefined);
  }

  private audioCpsCache = new Map<number, string>();
  private audioMime(a: RemuxAudio): string {
    return a.copy ? this.audioCpsCache.get(a.index) ?? "mp4a.40.2" : OUT_CPS[a.out!];
  }
  private async ensureCps(a: RemuxAudio | undefined) {
    if (a?.copy && !this.audioCpsCache.has(a.index)) this.audioCpsCache.set(a.index, (await this.tracks[a.index].getCodecParameterString()) ?? "mp4a.40.2");
  }
  private mimeFor(kind: Lane["kind"], a: RemuxAudio | undefined): string {
    if (kind === "video") return `video/mp4; codecs="${this.videoCodec}"`;
    if (kind === "audio") return `audio/mp4; codecs="${this.audioMime(a!)}"`;
    return `video/mp4; codecs="${this.videoCodec}${a ? `,${this.audioMime(a)}` : ""}"`;
  }

  /** (Re)prepare a lane's SourceBuffer for a new start time: clear it, switch its type, set the offset. */
  private async resetBuffer(l: Lane, start: number, mime: string) {
    if (!l.sb) {
      l.sb = this.mse.addSourceBuffer(mime);
      l.sb.mode = "segments";
    } else {
      await this.idle(l);
      if (this.mse.readyState === "open") l.sb.abort();
      await this.removeRange(l, 0, Infinity);
      if (typeof l.sb.changeType === "function") l.sb.changeType(mime);
      else {
        this.mse.removeSourceBuffer(l.sb); // browsers without changeType: start a fresh buffer instead
        l.sb = this.mse.addSourceBuffer(mime);
        l.sb.mode = "segments";
      }
    }
    l.sb.timestampOffset = start;
    l.done = false;
    l.until = 0;
  }

  private async begin(at: number) {
    if (this.dead || this.opening) return;
    this.opening = true;
    try {
      this.gen++;
      const audio = this.audios[this.audioIndex];
      await this.ensureCps(audio);
      const start = Math.max(0, Math.min(at, Math.max(0, this.duration - 1)));
      if (!this.lanes.length) {
        // All SourceBuffers must exist before any data is appended, so the layout is fixed for the session.
        // Video always goes through our own copy pipeline (separate from the sound), which trusts the file's key
        // frames. A combined lane ran video through mediabunny's Conversion, which left gaps after the first
        // fragment on some files: the picture froze a few seconds in with minutes buffered past the gap.
        this.lanes = audio ? [new Lane("video"), new Lane("audio")] : [new Lane("video")];
        for (const l of this.lanes) {
          l.sb = this.mse.addSourceBuffer(this.mimeFor(l.kind, audio));
          l.sb.mode = "segments";
        }
        this.mse.duration = this.duration;
      }
      for (const l of this.lanes) await this.resetBuffer(l, start, this.mimeFor(l.kind, audio));
      this.pendingSeek = start > 0.5 ? start : null;
      this.lastTrim = 0;
      for (const l of this.lanes) await this.startLane(l, start);
    } finally {
      this.opening = false;
    }
  }

  /** Restart just one lane (the audio lane on a language switch) at `at`, leaving the others playing. */
  private async restartLane(l: Lane, at: number) {
    await this.stopLane(l);
    const audio = this.audios[this.audioIndex];
    await this.ensureCps(audio);
    const start = Math.max(0, Math.min(at, Math.max(0, this.duration - 1)));
    await this.resetBuffer(l, start, this.mimeFor(l.kind, audio));
    await this.startLane(l, start);
  }

  private async startLane(l: Lane, start: number) {
    if (l.kind === "video") return this.startVideoCopy(l, start);
    const mb = this.mb;
    const gen = ++l.gen;
    const audio = this.audios[this.audioIndex];
    const output = new mb.Output({
      format: new mb.Mp4OutputFormat({ fastStart: "fragmented", minimumFragmentDuration: 1 }),
      target: new mb.StreamTarget(new WritableStream({ write: (chunk) => this.push(l, gen, chunk.data) }), { chunked: false }),
    });
    const wanted = audio ? this.tracks[audio.index] : null;
    const audioCfg = (t: InputAudioTrack) =>
      wanted && t === wanted
        ? audio!.copy
          ? {}
          : {
              codec: audio!.out!,
              ...(audio!.out === "flac" ? { sampleFormat: "s16" as const } : {}),
              // Converted sound is always mixed down to stereo: Safari's encoder put 5.1 out of one speaker, and
              // browser AAC encoders take at most 5.1 anyway. Stereo plays correctly everywhere.
              numberOfChannels: 2,
            }
        : { discard: true };
    const conversion = await mb.Conversion.init({
      input: this.input,
      output,
      trim: { start },
      video: l.kind === "audio" ? { discard: true } : { forceTranscode: false },
      audio: audioCfg, // video lanes never get here (startVideoCopy)
      subtitle: { discard: true },
      showWarnings: false,
    } as never);
    if (!conversion.isValid) throw new RemuxUnsupported("Conversion not possible in this browser");
    l.conversion = conversion;
    void this.pump(l, gen, conversion, start);
  }

  /**
   * Video lane: copy the video packets ourselves instead of through Conversion, which re-verifies every key frame
   * and, on Chromium, only accepts true IDR frames. Blu-ray encodes are open-GOP (key frames are plain I-frames
   * with a recovery point), so a whole film could have one IDR: fragments then grew to ~90 s before anything
   * played, and every seek restarted from 0:00. Here the file's own key-frame marks are trusted: fragments every
   * ~second, and seeks start at the nearest key frame.
   */
  private async startVideoCopy(l: Lane, start: number) {
    const mb = this.mb;
    const gen = ++l.gen;
    const track = (await this.input.getPrimaryVideoTrack())!;
    const sink = new mb.EncodedPacketSink(track);
    const first = (await sink.getKeyPacket(start)) ?? (await sink.getFirstKeyPacket());
    if (!first) throw new RemuxUnsupported("No key frame to start from");
    // Timestamps go in relative to the start key frame; the SourceBuffer puts them back on the film's timeline.
    // Set before the muxer writes anything: browsers refuse to change the offset mid-append.
    const base = first.timestamp;
    await this.idle(l);
    l.sb!.timestampOffset = base;
    const output = new mb.Output({
      format: new mb.Mp4OutputFormat({ fastStart: "fragmented", minimumFragmentDuration: 1 }),
      target: new mb.StreamTarget(new WritableStream({ write: (chunk) => this.push(l, gen, chunk.data) }), { chunked: false }),
    });
    const source = new mb.EncodedVideoPacketSource((await track.getCodec())!);
    output.addVideoTrack(source);
    await output.start();
    l.stop = async () => {
      await output.cancel().catch(() => undefined);
    };
    void this.videoPump(l, gen, sink, first, base, start, output, source, { decoderConfig: (await track.getDecoderConfig()) ?? undefined });
  }

  private async videoPump(
    l: Lane,
    gen: number,
    sink: import("mediabunny").EncodedPacketSink,
    first: import("mediabunny").EncodedPacket,
    base: number,
    start: number,
    output: import("mediabunny").Output,
    source: import("mediabunny").EncodedVideoPacketSource,
    meta: { decoderConfig?: VideoDecoderConfig },
  ) {
    const audioLane = this.lanes[1] ?? null;
    let n = 0;
    let firstGop = true;
    let lastBytes = l.appended;
    let lastAt = 0;
    try {
      for await (const p of sink.packets(first)) {
        if (this.dead || gen !== l.gen) return;
        // Leading frames right after an open-GOP key frame belong to the previous group and can't be decoded
        // from here; drop them in the first group only.
        if (firstGop && p.timestamp < base) continue;
        if (p.type === "key" && p !== first && p.timestamp > base) firstGop = false;
        if (n++ % 24 === 0) {
          // Pace: stop while enough is buffered, or while running more than 30 s ahead of the audio lane.
          while (!this.dead && gen === l.gen && (this.laneAhead(l) > this.aheadTarget(l) || (audioLane && !audioLane.done && l.until > audioLane.until + 30))) await sleep(300);
          if (this.dead || gen !== l.gen) return;
        }
        await source.add(p.clone({ timestamp: p.timestamp - base }), n === 1 ? meta : undefined);
        l.until = p.timestamp - start;
        if (l.until - lastAt >= 2) {
          const r = (l.appended - lastBytes) / (l.until - lastAt);
          if (r > 0) l.rate = l.rate ? l.rate * 0.7 + r * 0.3 : r;
          l.squeeze = Math.min(1, l.squeeze + 0.02);
          lastBytes = l.appended;
          lastAt = l.until;
        }
      }
      if (gen !== l.gen) return;
      await output.finalize();
      await l.chain;
      l.done = true;
      if (!this.dead && gen === l.gen && this.lanes.every((x) => x.done) && this.mse.readyState === "open") this.mse.endOfStream();
    } catch (e) {
      if (!this.dead && gen === l.gen && !/cancel/i.test(String((e as Error)?.message ?? e))) this.fail(e);
    }
  }

  private aheadTarget(l: Lane): number {
    if (!l.rate) return BUFFER_MIN;
    return Math.max(20, Math.min(BUFFER_MAX, Math.max(BUFFER_MIN, MEM_BUDGET / l.rate)) * l.squeeze);
  }

  /** Convert in growing steps, pausing while enough is buffered ahead of the playhead. */
  private async pump(l: Lane, gen: number, c: Conversion, start: number) {
    try {
      // Start small so the first picture appears fast (a 4K remux is ~10 MB per second of film), then grow.
      let step = 2;
      for (;;) {
        if (this.dead || gen !== l.gen) return;
        if (this.laneAhead(l) > this.aheadTarget(l)) {
          await sleep(400);
          continue;
        }
        l.until += step;
        const before = l.appended;
        await c.execute({ until: l.until });
        const r = (l.appended - before) / step; // this step's bytes per second of film
        if (r > 0) l.rate = l.rate ? l.rate * 0.7 + r * 0.3 : r;
        l.squeeze = Math.min(1, l.squeeze + 0.02);
        step = Math.min(20, Math.ceil(step * 2));
        if (c.state === "done" || l.until > this.duration - start + 30) break;
      }
      await l.chain;
      l.done = true;
      if (!this.dead && gen === l.gen && this.lanes.every((x) => x.done) && this.mse.readyState === "open") this.mse.endOfStream();
    } catch (e) {
      if (!this.dead && gen === l.gen && !String((e as Error)?.name).includes("Cancel")) this.fail(e);
    }
  }

  // --- SourceBuffer plumbing ---------------------------------------------------------------

  private push(l: Lane, gen: number, data: Uint8Array): Promise<void> {
    if (gen !== l.gen || this.dead) return Promise.resolve();
    const copy = new Uint8Array(data); // the muxer may reuse its buffer
    l.chain = l.chain.then(() => (gen === l.gen && !this.dead ? this.append(l, copy) : undefined));
    return l.chain;
  }

  private idle(l: Lane): Promise<void> {
    const sb = l.sb;
    if (!sb || !sb.updating) return Promise.resolve();
    return new Promise((r) => sb.addEventListener("updateend", () => r(), { once: true }));
  }

  private async append(l: Lane, data: Uint8Array, retry = true): Promise<void> {
    const sb = l.sb!;
    l.appended += data.byteLength;
    await this.idle(l);
    try {
      await new Promise<void>((res, rej) => {
        sb.addEventListener("updateend", () => res(), { once: true });
        sb.addEventListener("error", () => rej(new Error("SourceBuffer error")), { once: true });
        sb.appendBuffer(data as BufferSource as ArrayBuffer);
      });
    } catch (e) {
      if (retry && (e as DOMException)?.name === "QuotaExceededError") {
        // The browser's memory cap: aim lower from now on, free what's behind, and wait for playback to make
        // room, rather than giving up (which would drop to TorBox's slower transcode).
        l.appended -= data.byteLength;
        l.squeeze = Math.max(0.25, l.squeeze * 0.7);
        for (let i = 0; i < 60 && !this.dead; i++) {
          const t = this.video?.currentTime ?? 0;
          await this.removeRange(l, 0, Math.max(0, t - 5));
          try {
            return await this.append(l, data, false);
          } catch (e2) {
            if ((e2 as DOMException)?.name !== "QuotaExceededError") throw e2;
            l.appended -= data.byteLength;
            await sleep(1000);
          }
        }
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

  private async removeRange(l: Lane, from: number, to: number) {
    const sb = l.sb;
    if (!sb || this.mse.readyState !== "open") return;
    await this.idle(l);
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
    for (const l of this.lanes) {
      l.gen++;
      void (l.stop ? l.stop() : l.conversion?.cancel())?.catch(() => undefined);
    }
    try {
      this.input?.dispose();
    } catch {
      /* already disposed */
    }
    URL.revokeObjectURL(this.url);
  }
}

/** One SourceBuffer and the conversion feeding it: "av" (both tracks), or "video" / "audio" in split mode. */
class Lane {
  sb: SourceBuffer | null = null;
  conversion: Conversion | null = null;
  chain: Promise<void> = Promise.resolve();
  gen = 0;
  appended = 0;
  rate = 0; // bytes per second of film, measured as it converts
  squeeze = 1; // shrinks when the browser refuses more data (its memory cap), recovers slowly
  until = 0; // seconds converted since this lane's start
  done = false;
  stop: (() => Promise<void>) | null = null; // the video lane's own copy pipeline (no Conversion)
  constructor(readonly kind: "av" | "video" | "audio") {}
}

const ISO3: Record<string, string> = { eng: "en", ita: "it", fra: "fr", fre: "fr", deu: "de", ger: "de", spa: "es", por: "pt", rus: "ru", jpn: "ja", kor: "ko", zho: "zh", chi: "zh", ara: "ar", hin: "hi", nld: "nl", dut: "nl", pol: "pl", tur: "tr", swe: "sv" };
const langIso3to2 = (l: string) => ISO3[l.toLowerCase()] ?? l.slice(0, 2).toLowerCase();
