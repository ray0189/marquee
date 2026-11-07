import { useEffect, useMemo, useState } from "react";
import { withSession } from "../api";
import { rankForBrowser } from "./rank";
import type { MediaType, StreamEvent, StreamItem } from "../types";

export interface StreamsState {
  items: StreamItem[];
  hidden: number;
  final: boolean;
  error: string | null;
  warning: string | null;
  indexers: { name: string; count: number; ms: number; error: string | null }[];
}

const EMPTY: StreamsState = { items: [], hidden: 0, final: false, error: null, warning: null, indexers: [] };

/** Live source list for a title or episode, streamed over SSE so results appear as indexers answer. */
export function useStreams(type: MediaType, id: number, season?: number | null, episode?: number | null, enabled = true): StreamsState {
  const [state, setState] = useState<StreamsState>(EMPTY);

  useEffect(() => {
    if (!enabled) return;
    setState(EMPTY);
    const qs = type === "tv" ? `?season=${season}&episode=${episode}` : "";
    const es = new EventSource(withSession(`/api/streams/${type}/${id}${qs}`), { withCredentials: true });
    let finished = false;

    es.onmessage = (m) => {
      let ev: StreamEvent;
      try {
        ev = JSON.parse(m.data) as StreamEvent;
      } catch {
        return; // a truncated or garbled event shouldn't take down the whole list
      }
      setState((s) => {
        switch (ev.type) {
          case "streams":
            return { ...s, items: ev.items, hidden: ev.hidden, final: ev.final };
          case "indexer":
            return { ...s, indexers: [...s.indexers, { name: ev.name, count: ev.count, ms: ev.ms, error: ev.error }] };
          case "warning":
            return { ...s, warning: ev.message };
          case "error":
            return { ...s, error: ev.message, final: true };
          case "done":
            return { ...s, final: true };
          default:
            return s;
        }
      });
      if (ev.type === "done" || ev.type === "error") {
        finished = true;
        es.close();
      }
    };
    es.onerror = () => {
      es.close();
      if (!finished) setState((s) => (s.final ? s : { ...s, final: true, error: s.items.length ? null : "Couldn't reach the source finder." }));
    };
    return () => es.close();
  }, [type, id, season, episode, enabled]);

  return useMemo(() => ({ ...state, items: rankForBrowser(state.items) }), [state]);
}
