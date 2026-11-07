export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public mode?: string) {
    super(message);
  }
}

/**
 * The invite session. It normally lives in an httpOnly cookie, but some devices drop cookies (private modes,
 * in-app browsers, strict tracking protection), so Join also keeps the signed value here and every call sends
 * it too. The server accepts either.
 */
const SESSION_KEY = "mq_session";
export const session = {
  get: () => {
    try {
      return localStorage.getItem(SESSION_KEY) ?? "";
    } catch {
      return "";
    }
  },
  set: (v: string) => {
    try {
      localStorage.setItem(SESSION_KEY, v);
    } catch {
      /* storage unavailable: the cookie still works */
    }
  },
  clear: () => {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      /* nothing to clear */
    }
  },
};
/**
 * For URLs the browser fetches by itself (EventSource, <track>), which can't carry headers. These get a
 * short-lived token, never the long-lived session, which would otherwise land in proxy logs and history.
 */
let urlToken = "";
let urlTokenTimer: number | undefined;
export async function refreshUrlToken(): Promise<void> {
  try {
    const r = await request<{ token: string; max_age: number }>("/api/url-token");
    urlToken = r.token;
    window.clearTimeout(urlTokenTimer);
    urlTokenTimer = window.setTimeout(() => void refreshUrlToken(), Math.max(60, r.max_age / 2) * 1000);
  } catch {
    /* the cookie or header still works on most devices */
  }
}
export const withSession = (url: string) => (urlToken ? `${url}${url.includes("?") ? "&" : "?"}mq_t=${encodeURIComponent(urlToken)}` : url);
export const sessionHeaders = (): Record<string, string> => {
  const s = session.get();
  return s ? { "X-MQ-Session": s } : {};
};

async function request<T>(path: string, init: RequestInit = {}, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...sessionHeaders(), ...headers },
  });
  if (!res.ok) {
    let code = "ERROR";
    let message = `Something went wrong (${res.status})`;
    let mode: string | undefined;
    try {
      const body = await res.json();
      const d = body.detail;
      if (d && typeof d === "object" && !Array.isArray(d)) {
        code = d.code ?? code;
        message = d.message ?? message;
        mode = d.mode;
      } else if (Array.isArray(d)) {
        message = d.map((x: { msg?: string }) => x.msg).filter(Boolean).join("; ") || message;
      }
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, code, message, mode);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** Viewer API. A 401 means the invite link is missing or revoked: tell the app shell. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    return await request<T>(path, init);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) window.dispatchEvent(new Event("mq:noaccess"));
    throw e;
  }
}

export const post = <T,>(path: string, body: unknown) => api<T>(path, { method: "POST", body: JSON.stringify(body) });
export const put = <T,>(path: string, body: unknown) => api<T>(path, { method: "PUT", body: JSON.stringify(body) });

// --- admin ---------------------------------------------------------------------------------

const TOKEN_KEY = "mq_admin_token";
export const adminToken = {
  get: () => sessionStorage.getItem(TOKEN_KEY) ?? "",
  set: (t: string) => sessionStorage.setItem(TOKEN_KEY, t),
  clear: () => sessionStorage.removeItem(TOKEN_KEY),
};

export function admin<T>(path: string, init?: RequestInit): Promise<T> {
  const t = adminToken.get();
  return request<T>("/api/admin" + path, init, t ? { "X-Admin-Token": t } : {});
}
export const adminSend = <T,>(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown) =>
  admin<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

// --- images --------------------------------------------------------------------------------

export function img(path: string | null | undefined, size: "w185" | "w342" | "w500" | "w780" | "w1280" | "original" = "w500"): string | undefined {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : undefined;
}
