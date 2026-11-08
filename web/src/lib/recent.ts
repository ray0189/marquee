/** Recent searches, kept on this device only (friends never see each other's). Newest first, max 10. */
const KEY = "mq_recent_searches";
const MAX = 10;

export function recentSearches(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function save(list: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* private mode or storage full: history is a nicety, never an error */
  }
}

export function addRecentSearch(term: string): string[] {
  const t = term.trim().replace(/\s+/g, " ");
  if (t.length < 2) return recentSearches();
  const list = [t, ...recentSearches().filter((x) => x.toLowerCase() !== t.toLowerCase())];
  save(list);
  return list.slice(0, MAX);
}

export function removeRecentSearch(term: string): string[] {
  const list = recentSearches().filter((x) => x !== term);
  save(list);
  return list;
}

export function clearRecentSearches(): string[] {
  save([]);
  return [];
}
