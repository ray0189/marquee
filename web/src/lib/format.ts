import type { Release } from "../types";

export function fmtSize(bytes: number): string {
  if (!bytes) return "";
  const gb = bytes / 1e9;
  return gb >= 1 ? `${gb.toFixed(gb >= 10 ? 0 : 1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

export function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtRuntime(min: number | null): string {
  if (!min) return "";
  const h = Math.floor(min / 60);
  return h ? `${h}h ${min % 60}m` : `${min}m`;
}

export function resLabel(r: number): string {
  return r >= 2160 ? "4K" : r ? `${r}p` : "—";
}

export function releaseTags(r: Release): string[] {
  const tags: string[] = [];
  if (r.source) tags.push(r.source === "web-dl" ? "WEB-DL" : r.source === "webrip" ? "WEBRip" : r.source.toUpperCase());
  if (r.codec) tags.push(r.codec === "hevc" ? "HEVC" : r.codec === "avc" ? "H.264" : r.codec.toUpperCase());
  tags.push(...r.hdr);
  const audio = r.audio.find((a) => ["atmos", "truehd", "dtsx", "dtshd"].includes(a)) ?? r.audio[0];
  if (audio) tags.push({ atmos: "Atmos", truehd: "TrueHD", dtsx: "DTS:X", dtshd: "DTS-HD", eac3: "DD+", ac3: "DD", dts: "DTS", aac: "AAC", opus: "Opus", flac: "FLAC", mp3: "MP3" }[audio] ?? audio);
  return tags;
}

export function epLabel(season?: number | null, episode?: number | null): string {
  return season != null && episode != null ? `S${season} · E${episode}` : "";
}
