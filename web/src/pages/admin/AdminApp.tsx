import { Activity, Copy, KeyRound, Link2, LogOut, RefreshCw, Rss, SlidersHorizontal, Trash2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Fragment, useCallback, useEffect, useState } from "react";
import { ApiError, admin, adminSend, adminToken, post } from "../../api";
import { Wordmark } from "../../components/Logo";

type Tab = "overview" | "links" | "sources" | "quality" | "keys";
const TABS: { id: Tab; label: string; icon: typeof Activity }[] = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "links", label: "Invite links", icon: Link2 },
  { id: "sources", label: "Sources", icon: Rss },
  { id: "quality", label: "Quality", icon: SlidersHorizontal },
  { id: "keys", label: "Keys", icon: KeyRound },
];

interface Status {
  torbox: { configured: boolean; ok?: boolean; plan?: number | string; email?: string; error?: string; premium_expires_at?: string; source?: string };
  limits: { minute: { used: number; limit: number }; hour: { used: number; limit: number } };
  library: { items: number; synced_at: number | null };
  plays_10m: number;
  links: { active: number; total: number };
  indexers: { name: string; url: string; enabled: boolean; timeout: number; down: boolean; last: { ok?: boolean; ms?: number; count?: number; error?: string } | null }[];
  tmdb: { configured: boolean };
  search: { documents: number | null };
}
interface LinkRow {
  id: number;
  label: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  play_count: number;
  url?: string | null;
  devices?: DeviceRow[];
  max_devices?: number;
}
interface DeviceRow {
  id: number;
  user_agent: string;
  ip: string;
  created_at: string;
  last_seen_at: string | null;
}
function deviceName(ua: string): string {
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac"
    : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux" : "Device";
  const br = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return br ? `${os} · ${br}` : os;
}
interface Quality {
  cached_only: boolean;
  allow_uncached_add: boolean;
  min_resolution: number;
  blocked: string[];
  browser_bias: number;
  prefer_hdr: boolean;
  max_results: number;
}
interface Indexer {
  name: string;
  url: string;
  enabled: boolean;
  timeout: number;
}

const ago = (iso: string | null) => {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

function Gauge({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = Math.min(100, (used / Math.max(1, limit)) * 100);
  const hot = pct > 80;
  return (
    <div className="card">
      <div className="flex items-baseline justify-between">
        <span className="label !mb-0">{label}</span>
        <span className="font-display text-2xl font-semibold tabular-nums">
          {used}
          <span className="text-base text-bone-mute"> / {limit}</span>
        </span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
        <div className={`h-full rounded-full transition-all duration-700 ${hot ? "bg-ember" : "bg-amber"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="card">
      <div className="label !mb-1">{label}</div>
      <div className="font-display text-3xl font-semibold">{value}</div>
      {sub && <div className="mt-1 text-xs text-bone-mute">{sub}</div>}
    </div>
  );
}

function Overview() {
  const [s, setS] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const load = useCallback(() => admin<Status>("/status").then(setS).catch((e) => setErr(e.message)), []);
  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  if (!s) return <div className="text-bone-mute">{err || "Loading…"}</div>;
  const tb = s.torbox;
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2">
        <Gauge label="TorBox calls · last minute" {...s.limits.minute} />
        <Gauge label="Torrents added · last hour" {...s.limits.hour} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="TorBox"
          value={!tb.configured ? "No key" : tb.ok ? <span className="text-moss">Connected</span> : <span className="text-ember">Error</span>}
          sub={tb.ok ? `${tb.email ?? ""}${tb.source ? ` · key from ${tb.source}` : ""}` : tb.error}
        />
        <Stat label="Library" value={s.library.items} sub={s.library.synced_at ? `synced ${ago(new Date(s.library.synced_at * 1000).toISOString())}` : "not synced yet"} />
        <Stat label="Plays · 10 min" value={s.plays_10m} />
        <Stat label="Active links" value={s.links.active} sub={`${s.links.total} created`} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card">
          <div className="label">Sources</div>
          <div className="divide-y divide-white/5">
            {s.indexers.map((ix) => (
              <div key={ix.name} className="flex items-center gap-3 py-2.5 text-sm">
                <span className={`h-2 w-2 rounded-full ${!ix.enabled ? "bg-bone-mute" : ix.down ? "bg-ember" : "bg-moss"}`} />
                <span className="font-medium">{ix.name}</span>
                <span className="ml-auto text-xs text-bone-mute">
                  {!ix.enabled ? "off" : ix.down ? "paused after errors" : ix.last ? `${ix.last.count ?? 0} results · ${ix.last.ms ?? "?"}ms` : "idle"}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="card space-y-3 text-sm">
          <div className="label">Services</div>
          <div className="flex justify-between"><span className="text-bone-dim">TMDB catalogue</span><span className={s.tmdb.configured ? "text-moss" : "text-ember"}>{s.tmdb.configured ? "Key set" : "Missing key"}</span></div>
          <div className="flex justify-between"><span className="text-bone-dim">Search index</span><span>{s.search.documents == null ? "Unavailable (using TMDB)" : `${s.search.documents.toLocaleString()} titles`}</span></div>
          <button
            className="btn-ghost w-full"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await adminSend("POST", "/library/sync");
                await load();
              } catch (e) {
                setErr((e as Error).message);
              }
              setBusy(false);
            }}
          >
            <RefreshCw size={15} className={busy ? "animate-spin" : ""} /> Sync library now
          </button>
          {err && <p className="text-xs text-ember">{err}</p>}
        </div>
      </div>
    </div>
  );
}

/** navigator.clipboard only exists on HTTPS or localhost; the NAS serves admin over plain http on the LAN,
 *  so fall back to the old select-and-copy route. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

function Links() {
  const [rows, setRows] = useState<LinkRow[]>([]);
  const [label, setLabel] = useState("");
  const [fresh, setFresh] = useState<LinkRow | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [tab, setTab] = useState<"active" | "revoked">("active");
  const revokedCount = rows.filter((r) => r.revoked_at).length;
  const shown = rows.filter((r) => (tab === "revoked") === !!r.revoked_at);
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const load = useCallback(() => admin<LinkRow[]>("/links").then(setRows), []);
  useEffect(() => {
    load();
  }, [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim()) return;
    const r = await adminSend<LinkRow>("POST", "/links", { label: label.trim() });
    setFresh(r);
    setLabel("");
    load();
  };

  return (
    <div className="space-y-6">
      <form onSubmit={create} className="card flex flex-wrap items-end gap-3">
        <div className="min-w-[220px] flex-1">
          <label className="label">Who is this for?</label>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Sam, cousin Dee" maxLength={80} />
        </div>
        <button className="btn-primary" disabled={!label.trim()}>Create link</button>
      </form>

      {fresh?.url && (
        <div className="card border-amber/40 bg-amber/[0.06]">
          <div className="flex flex-wrap items-center gap-6">
            <div className="rounded-xl bg-white p-3">
              <QRCodeSVG value={fresh.url} size={120} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="label">Link for {fresh.label}</div>
              <div className="select-all break-all rounded-lg bg-ink-950/60 p-3 font-mono text-xs">{fresh.url}</div>
              <div className="mt-3 flex gap-2">
                <button
                  className="btn-primary"
                  onClick={async () => {
                    setCopied((await copyText(fresh.url!)) ? "yes" : "no");
                    setTimeout(() => setCopied(null), 2000);
                  }}
                >
                  <Copy size={15} /> {copied === "yes" ? "Copied" : copied === "no" ? "Select it and copy" : "Copy"}
                </button>
                <button className="btn-quiet" onClick={() => setFresh(null)}>Done</button>
              </div>
              <p className="mt-2 text-xs text-bone-mute">You can show this again any time from the list below.</p>
            </div>
          </div>
        </div>
      )}

      <div className="mb-3 flex gap-2">
        {(["active", "revoked"] as const).map((t) => (
          <button key={t} className={tab === t ? "btn-primary !px-4 !py-1.5" : "btn-quiet !px-4 !py-1.5"} onClick={() => setTab(t)}>
            {t === "active" ? `Active (${rows.length - revokedCount})` : `Revoked (${revokedCount})`}
          </button>
        ))}
      </div>
      <div className="card !p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-white/[0.03] text-left text-xs uppercase tracking-wider text-bone-mute">
            <tr><th className="px-5 py-3">Name</th><th>Last seen</th><th>Devices</th><th>Plays</th><th>Created</th><th /></tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {shown.map((r) => (
              <Fragment key={r.id}>
              <tr className={r.revoked_at ? "opacity-50" : ""}>
                <td className="px-5 py-3 font-medium">{r.label} {r.revoked_at && <span className="chip ml-2">revoked</span>}</td>
                <td className="text-bone-dim">{ago(r.last_seen_at)}</td>
                <td className="tabular-nums text-bone-dim">
                  {r.revoked_at ? "–" : (
                    <button className="underline decoration-white/20 underline-offset-4 hover:text-bone" onClick={() => setOpen(open === r.id ? null : r.id)}>
                      {r.devices?.length ?? 0}/{r.max_devices ?? 5}
                    </button>
                  )}
                </td>
                <td className="tabular-nums text-bone-dim">{r.play_count}</td>
                <td className="text-bone-dim">{ago(r.created_at)}</td>
                <td className="whitespace-nowrap pr-4 text-right">
                  {!r.revoked_at && r.url && (
                    <button className="btn-quiet !px-3 !py-1.5" onClick={() => (setFresh(r), window.scrollTo({ top: 0, behavior: "smooth" }))}>
                      <Link2 size={14} /> Show link
                    </button>
                  )}
                  {!r.revoked_at && !r.url && (
                    <button
                      className="btn-quiet !px-3 !py-1.5"
                      title="This link was made before URLs were kept, so it can't be shown. Make a new URL for it."
                      onClick={async () => {
                        if (confirm(`Make a new URL for ${r.label}? Their old URL stops working, but if they're already signed in they stay signed in.`)) {
                          setFresh(await adminSend<LinkRow>("POST", `/links/${r.id}/rotate`));
                          load();
                          window.scrollTo({ top: 0, behavior: "smooth" });
                        }
                      }}
                    >
                      <RefreshCw size={14} /> New URL
                    </button>
                  )}
                  {!r.revoked_at && (
                    <button
                      className="btn-quiet !px-3 !py-1.5 text-ember"
                      onClick={async () => {
                        if (confirm(`Revoke ${r.label}'s link? It stops working immediately.`)) {
                          await adminSend("DELETE", `/links/${r.id}`);
                          load();
                        }
                      }}
                    >
                      <Trash2 size={14} /> Revoke
                    </button>
                  )}
                </td>
              </tr>
              {open === r.id && !r.revoked_at && (
                <tr className="bg-white/[0.02]">
                  <td colSpan={6} className="px-5 py-3">
                    {(r.devices ?? []).length === 0 && <p className="text-bone-mute">No devices yet.</p>}
                    <ul className="space-y-2">
                      {(r.devices ?? []).map((d) => (
                        <li key={d.id} className="flex items-center gap-4">
                          <span className="font-medium">{deviceName(d.user_agent)}</span>
                          <span className="text-bone-mute">{d.ip}</span>
                          <span className="text-bone-mute">seen {ago(d.last_seen_at)}</span>
                          <button
                            className="btn-quiet ml-auto !px-3 !py-1 text-ember"
                            onClick={async () => {
                              if (confirm(`Sign out this ${deviceName(d.user_agent)}? It frees a slot; they can open the link again to come back.`)) {
                                await adminSend("DELETE", `/links/${r.id}/devices/${d.id}`);
                                load();
                              }
                            }}
                          >
                            <Trash2 size={14} /> Remove
                          </button>
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              )}
              </Fragment>
            ))}
            {shown.length === 0 && <tr><td colSpan={6} className="px-5 py-8 text-center text-bone-mute">{tab === "revoked" ? "No revoked links." : "No links yet."}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Sources() {
  const [list, setList] = useState<Indexer[]>([]);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    admin<Indexer[]>("/settings/indexers").then(setList);
  }, []);
  const set = (i: number, patch: Partial<Indexer>) => setList((l) => l.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const save = async () => {
    try {
      await adminSend("PUT", "/settings/indexers", list);
      setMsg("Saved.");
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-bone-dim">Stremio-style addon base URLs (the part before <code className="text-amber">/stream/…</code>). All enabled sources are queried in parallel; one that keeps failing is paused for five minutes.</p>
      {list.map((ix, i) => (
        <div key={i} className="card grid gap-3 md:grid-cols-[160px_1fr_90px_auto_auto] md:items-end">
          <div><label className="label">Name</label><input className="input" value={ix.name} onChange={(e) => set(i, { name: e.target.value })} /></div>
          <div><label className="label">Base URL</label><input className="input font-mono text-xs" value={ix.url} onChange={(e) => set(i, { url: e.target.value })} /></div>
          <div><label className="label">Timeout s</label><input className="input" type="number" min={2} max={20} value={ix.timeout} onChange={(e) => set(i, { timeout: Number(e.target.value) })} /></div>
          <label className="flex items-center gap-2 pb-2.5 text-sm"><input type="checkbox" checked={ix.enabled} onChange={(e) => set(i, { enabled: e.target.checked })} className="accent-amber" /> On</label>
          <button className="btn-quiet pb-0 text-ember" onClick={() => setList((l) => l.filter((_, j) => j !== i))}><Trash2 size={15} /></button>
        </div>
      ))}
      <div className="flex items-center gap-3">
        <button className="btn-ghost" onClick={() => setList((l) => [...l, { name: "", url: "https://", enabled: true, timeout: 8 }])}>Add source</button>
        <button className="btn-primary" onClick={save}>Save</button>
        {msg && <span className="text-sm text-bone-dim">{msg}</span>}
      </div>
    </div>
  );
}

function QualityTab() {
  const [q, setQ] = useState<Quality | null>(null);
  const [blocked, setBlocked] = useState("");
  const [msg, setMsg] = useState("");
  useEffect(() => {
    admin<Quality>("/settings/quality").then((r) => {
      setQ(r);
      setBlocked(r.blocked.join(", "));
    });
  }, []);
  if (!q) return null;
  const set = (patch: Partial<Quality>) => setQ({ ...q, ...patch });
  const save = async () => {
    try {
      const body = { ...q, blocked: blocked.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean) };
      await adminSend("PUT", "/settings/quality", body);
      setMsg("Saved. Cached source lists were cleared.");
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const Toggle = ({ k, label, hint }: { k: "cached_only" | "allow_uncached_add" | "prefer_hdr"; label: string; hint: string }) => (
    <label className="flex cursor-pointer items-start gap-3">
      <input type="checkbox" className="mt-1 accent-amber" checked={q[k]} onChange={(e) => set({ [k]: e.target.checked })} />
      <span><span className="block text-sm font-medium">{label}</span><span className="text-xs text-bone-mute">{hint}</span></span>
    </label>
  );
  return (
    <div className="card max-w-2xl space-y-6">
      <Toggle k="cached_only" label="Only show instantly available sources" hint="Hides anything TorBox hasn't already cached." />
      <Toggle k="allow_uncached_add" label="Allow adding uncached torrents" hint="Uses the hourly add budget. Off keeps playback instant and ToS-friendly." />
      <Toggle k="prefer_hdr" label="Prefer HDR / Dolby Vision" hint="Browsers often tone-map these badly; leave off unless your viewers use Safari." />
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label">Minimum resolution</label>
          <select className="input" value={q.min_resolution} onChange={(e) => set({ min_resolution: Number(e.target.value) })}>
            {[0, 480, 720, 1080, 2160].map((r) => <option key={r} value={r}>{r === 0 ? "Any" : r === 2160 ? "4K" : `${r}p`}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Max results shown</label>
          <input className="input" type="number" min={5} max={200} value={q.max_results} onChange={(e) => set({ max_results: Number(e.target.value) })} />
        </div>
      </div>
      <div>
        <label className="label">Browser-friendly bias · {q.browser_bias}</label>
        <input type="range" min={0} max={100} value={q.browser_bias} onChange={(e) => set({ browser_bias: Number(e.target.value) })} className="w-full accent-amber" />
        <p className="mt-1 text-xs text-bone-mute">Higher favours MP4 / H.264 / AAC that plays directly without transcoding.</p>
      </div>
      <div>
        <label className="label">Blocked tags (comma separated)</label>
        <input className="input" value={blocked} onChange={(e) => setBlocked(e.target.value)} />
      </div>
      <div className="flex items-center gap-3">
        <button className="btn-primary" onClick={save}>Save</button>
        {msg && <span className="text-sm text-bone-dim">{msg}</span>}
      </div>
    </div>
  );
}

interface KeyInfo {
  set: boolean;
  last4: string;
  source: string;
}

function KeyForm({ title, hint, path, which, get }: { title: string; hint: string; path: string; which: "torbox" | "tmdb"; get: { url: string; how: string } }) {
  const [v, setV] = useState("");
  const [info, setInfo] = useState<KeyInfo | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const load = useCallback(() => admin<Record<string, KeyInfo>>("/settings/keys").then((r) => setInfo(r[which])).catch(() => undefined), [which]);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <form
      className="card space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await adminSend("PUT", path, { key: v });
          setMsg({ ok: true, t: "Key verified and saved." });
          setV("");
          load();
        } catch (err) {
          setMsg({ ok: false, t: (err as Error).message });
        }
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="font-display text-xl font-semibold">{title}</div>
        {info && (
          <span className={`chip ${info.set ? "border-moss/40 bg-moss/10 text-moss" : "border-ember/40 bg-ember/10 text-ember"}`}>
            {info.set ? `Saved · ends ${info.last4}` : "Not set"}
          </span>
        )}
      </div>
      <p className="text-sm text-bone-dim">{hint}</p>
      <p className="text-sm text-bone-dim">
        Get one:{" "}
        <a href={get.url} target="_blank" rel="noreferrer noopener" className="font-medium text-amber-glow underline underline-offset-4">
          {get.url.replace(/^https:\/\/(www\.)?/, "")}
        </a>{" "}
        · {get.how}
      </p>
      <input className="input font-mono" type="password" autoComplete="off" placeholder={info?.set ? "Paste a new key to replace it" : "Paste key"} value={v} onChange={(e) => setV(e.target.value)} />
      <div className="flex items-center gap-3">
        <button className="btn-primary" disabled={v.length < 8}>Verify &amp; save</button>
        {msg && <span className={`text-sm ${msg.ok ? "text-moss" : "text-ember"}`}>{msg.t}</span>}
      </div>
    </form>
  );
}

function ShareUrl() {
  const [v, setV] = useState("");
  const [msg, setMsg] = useState("");
  useEffect(() => {
    admin<{ watch_url: string }>("/settings/general").then((r) => setV(r.watch_url));
  }, []);
  return (
    <form
      className="card space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await adminSend("PUT", "/settings/general", { url: v });
          setMsg("Saved. New invite links will use this address.");
        } catch (err) {
          setMsg((err as Error).message);
        }
      }}
    >
      <div className="font-display text-xl font-semibold">Address friends use</div>
      <p className="text-sm text-bone-dim">The public address of the watch site. Invite links are built from it.</p>
      <input className="input font-mono text-xs" value={v} onChange={(e) => setV(e.target.value)} placeholder="https://watch.example.com" />
      <div className="flex items-center gap-3">
        <button className="btn-primary">Save</button>
        {msg && <span className="text-sm text-bone-dim">{msg}</span>}
      </div>
    </form>
  );
}

function AdminPassword() {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const mismatch = again.length > 0 && next !== again;
  return (
    <form
      className="card space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await adminSend("PUT", "/settings/password", { current: cur, new: next });
          adminToken.set(next); // this tab stays unlocked with the new password
          setMsg({ ok: true, t: "Password changed. Use the new one next time you sign in." });
          setCur("");
          setNext("");
          setAgain("");
        } catch (err) {
          setMsg({ ok: false, t: (err as Error).message });
        }
      }}
    >
      <div className="font-display text-xl font-semibold">Admin password</div>
      <p className="text-sm text-bone-dim">At least 10 characters. Friends' invite links are not affected.</p>
      <input className="input" type="password" autoComplete="current-password" placeholder="Current password" value={cur} onChange={(e) => setCur(e.target.value)} />
      <input className="input" type="password" autoComplete="new-password" placeholder="New password" value={next} onChange={(e) => setNext(e.target.value)} />
      <input className="input" type="password" autoComplete="new-password" placeholder="New password again" value={again} onChange={(e) => setAgain(e.target.value)} />
      <div className="flex items-center gap-3">
        <button className="btn-primary" disabled={!cur || next.length < 10 || next !== again}>Change password</button>
        {mismatch && <span className="text-sm text-ember">The new passwords don't match.</span>}
        {msg && !mismatch && <span className={`text-sm ${msg.ok ? "text-moss" : "text-ember"}`}>{msg.t}</span>}
      </div>
    </form>
  );
}

function Keys() {
  return (
    <div className="grid max-w-3xl gap-5">
      <ShareUrl />
      <KeyForm title="TorBox API key" path="/settings/torbox" which="torbox" hint="Stored encrypted on the server and never sent to a browser. Saving re-syncs the library. Rotate this if it was ever pasted anywhere." get={{ url: "https://torbox.app/settings", how: "sign in, then copy the API key from Settings (needs a paid plan)." }} />
      <KeyForm title="TMDB key" path="/settings/tmdb" which="tmdb" hint="Either the v3 API key or the long v4 read token. Powers posters, search and metadata." get={{ url: "https://www.themoviedb.org/settings/api", how: "free account, then request a developer key and copy the API Key or API Read Access Token." }} />
      <AdminPassword />
    </div>
  );
}

function Gate({ onReady }: { onReady: () => void }) {
  const [state, setState] = useState<"checking" | "token" | "setup" | "none" | "denied">("checking");
  const [t, setT] = useState("");
  const [t2, setT2] = useState("");
  const [err, setErr] = useState("");

  const check = useCallback(async () => {
    try {
      await admin("/ping");
      onReady();
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.mode === "setup") setState("setup");
        else if (e.mode === "none") setState("none");
        else if (e.mode === "access") setState("denied");
        else {
          setState("token");
          if (adminToken.get()) setErr("That password wasn't accepted.");
        }
      } else setState("token");
    }
  }, [onReady]);
  useEffect(() => {
    check();
  }, [check]);

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="card w-full max-w-sm space-y-4 text-center">
        <div className="flex justify-center"><Wordmark /></div>
        {state === "checking" && <p className="text-bone-mute">Checking…</p>}
        {state === "none" && <p className="text-sm text-bone-dim">Admin is switched off. Set <code className="text-amber">ADMIN_TOKEN</code> or configure Cloudflare Access, then restart.</p>}
        {state === "denied" && <p className="text-sm text-bone-dim">Your account isn't allowed here.</p>}
        {state === "setup" && (
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              if (t !== t2) return setErr("Passwords don't match.");
              try {
                await post("/api/admin/setup/password", { password: t });
                adminToken.set(t);
                setErr("");
                check();
              } catch (x) {
                setErr((x as Error).message);
              }
            }}
          >
            <p className="text-sm text-bone-dim">Welcome. Choose an admin password (10+ characters) to finish setup.</p>
            <input className="input text-center" type="password" autoComplete="new-password" autoFocus placeholder="New password" value={t} onChange={(e) => setT(e.target.value)} />
            <input className="input text-center" type="password" autoComplete="new-password" placeholder="Repeat it" value={t2} onChange={(e) => setT2(e.target.value)} />
            {err && <p className="text-xs text-ember">{err}</p>}
            <button className="btn-primary w-full" disabled={t.length < 10}>Create &amp; continue</button>
          </form>
        )}
        {state === "token" && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              adminToken.set(t);
              setErr("");
              check();
            }}
          >
            <input className="input text-center" type="password" autoFocus placeholder="Admin password" value={t} onChange={(e) => setT(e.target.value)} />
            {err && <p className="text-xs text-ember">{err}</p>}
            <button className="btn-primary w-full" disabled={!t}>Unlock</button>
          </form>
        )}
      </div>
    </div>
  );
}

export default function AdminApp() {
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");
  if (!ready) return <Gate onReady={() => setReady(true)} />;
  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-8 px-5 py-8 md:flex-row md:px-8">
      <aside className="md:w-56 md:shrink-0">
        <Wordmark className="mb-8" />
        <nav className="flex gap-1 overflow-x-auto md:flex-col">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-3 whitespace-nowrap rounded-xl px-4 py-2.5 text-sm font-medium transition ${tab === id ? "bg-amber/15 text-amber" : "text-bone-dim hover:bg-white/5 hover:text-bone"}`}
            >
              <Icon size={17} /> {label}
            </button>
          ))}
          {adminToken.get() && (
            <button
              className="mt-4 flex items-center gap-3 rounded-xl px-4 py-2.5 text-sm text-bone-mute hover:text-bone"
              onClick={() => {
                adminToken.clear();
                setReady(false);
              }}
            >
              <LogOut size={17} /> Lock
            </button>
          )}
        </nav>
      </aside>
      <main className="min-w-0 flex-1">
        <h1 className="mb-6 font-display text-3xl font-semibold">{TABS.find((t) => t.id === tab)?.label}</h1>
        {tab === "overview" && <Overview />}
        {tab === "links" && <Links />}
        {tab === "sources" && <Sources />}
        {tab === "quality" && <QualityTab />}
        {tab === "keys" && <Keys />}
      </main>
    </div>
  );
}
