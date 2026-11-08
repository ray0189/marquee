/* Scrub warm-up for TorBox's transcoded (HLS) streams.

   TorBox converts on demand: jumping far ahead waits 2-7 s for the first piece at the new spot, then the rest
   arrive in well under a second. While the viewer is still dragging the scrubber, ask for the piece under their
   finger, so TorBox is already converting it when they let go. Only the playlist and one piece are fetched; a
   newer drag position cancels the previous request. */

interface Seg {
  start: number;
  end: number;
  url: string;
}

export class HlsWarmer {
  private segs: Promise<Seg[]> | null = null;
  private ctrl: AbortController | null = null;
  private last = "";

  constructor(private playlist: string) {}

  private load(): Promise<Seg[]> {
    this.segs ??= (async () => {
      const base = new URL(this.playlist, location.href);
      let text = await (await fetch(base, { credentials: "same-origin" })).text();
      let at = base;
      // A master playlist points at a media playlist; follow the first one.
      const variant = text.split("\n").find((l) => l.trim() && !l.startsWith("#"));
      if (variant && /\.m3u8(\?|$)/.test(variant.trim())) {
        at = new URL(variant.trim(), base);
        text = await (await fetch(at, { credentials: "same-origin" })).text();
      }
      const out: Seg[] = [];
      let t = 0;
      let dur = 0;
      for (const raw of text.split("\n")) {
        const l = raw.trim();
        if (l.startsWith("#EXTINF:")) dur = parseFloat(l.slice(8)) || 0;
        else if (l && !l.startsWith("#")) {
          const u = new URL(l, at);
          if (!u.search && at.search) u.search = at.search; // TorBox's pieces need the playlist's token
          out.push({ start: t, end: t + dur, url: u.href });
          t += dur;
        }
      }
      return out;
    })().catch(() => {
      this.segs = null; // try again on the next drag
      return [];
    });
    return this.segs;
  }

  /** Start conversion of the piece at `time` (seconds). Cheap to call repeatedly while dragging. */
  async warm(time: number): Promise<void> {
    const segs = await this.load();
    const seg = segs.find((s) => time >= s.start && time < s.end);
    if (!seg || seg.url === this.last) return;
    this.last = seg.url;
    this.ctrl?.abort();
    this.ctrl = new AbortController();
    // Read it to the end (cancelling early could cancel TorBox's work too); the browser may also reuse it.
    fetch(seg.url, { signal: this.ctrl.signal, credentials: "same-origin" })
      .then((r) => r.arrayBuffer())
      .catch(() => undefined);
  }

  dispose() {
    this.ctrl?.abort();
  }
}
