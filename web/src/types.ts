export type MediaType = "movie" | "tv";

export interface Card {
  id: number;
  type: MediaType;
  title: string;
  year: number | null;
  poster: string | null;
  backdrop: string | null;
  overview: string;
  rating: number;
}

export interface Release {
  resolution: number;
  source: string;
  codec: string;
  hdr: string[];
  audio: string[];
  container: string;
  flags: string[];
}

export interface StreamItem {
  hash: string;
  title: string;
  size: number;
  seeders: number;
  cached: boolean;
  owned: boolean;
  indexers: string[];
  release: Release;
  score: number;
}

export interface SeasonInfo {
  number: number;
  name: string | null;
  episodes: number;
  poster: string | null;
  air_date: string | null;
}

export interface Meta extends Card {
  imdb_id: string | null;
  tagline: string;
  runtime: number | null;
  genres: string[];
  certification: string;
  cast: { name: string; character: string; photo: string | null }[];
  seasons: SeasonInfo[];
  /** Latest episode that has aired (series only). */
  last_aired?: { season: number; episode: number } | null;
  similar: Card[];
}

export interface Episode {
  number: number;
  name: string | null;
  overview: string;
  still: string | null;
  air_date: string | null;
  runtime: number | null;
  rating: number;
}

export interface HistoryItem {
  type: MediaType;
  id: number;
  season: number | null;
  episode: number | null;
  position: number;
  duration: number;
  title: string;
  poster: string | null;
  backdrop: string | null;
  updated_at: string;
}

export interface AudioTrack {
  index?: number;
  language?: string;
  title?: string;
  name?: string;
}

export interface SubtitleTrack {
  id: string;
  lang: string;
  label: string;
  url: string;
}

export interface PlayResult {
  url: string;
  /** Same-origin copy of the file, for when the CDN can't be read cross-origin. */
  proxy?: string;
  note?: string;
  mime: string;
  mode: "direct" | "hls" | "remux";
  file: { name: string; size: number };
  hints: Release;
  audios?: AudioTrack[];
  needs_transcoding?: boolean | null;
}

export type StreamEvent =
  | { type: "start"; title: string }
  | { type: "indexer"; name: string; count: number; ms: number; error: string | null }
  | { type: "streams"; final: boolean; items: StreamItem[]; hidden: number; from_cache?: boolean }
  | { type: "warning"; message: string }
  | { type: "error"; code: string; message: string }
  | { type: "done" };
