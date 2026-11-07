import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ApiError, api, post, session } from "../api";
import { LogoMark } from "../components/Logo";
import { device } from "../lib/device";

const HIDE_KEY = "mq_hide_welcome";

export default function Join() {
  const { token } = useParams();
  const nav = useNavigate();
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [welcome, setWelcome] = useState<string | null>(null);
  const [hide, setHide] = useState(false);
  const enter = () => {
    if (hide) try { localStorage.setItem(HIDE_KEY, "1"); } catch { /* private mode: just show it next time */ }
    nav("/", { replace: true });
  };

  useEffect(() => {
    (async () => {
      try {
        const r = await post<{ label: string; session?: string }>("/api/join", { token });
        // Keep the signed session on the device as well as in the cookie, so a browser that drops cookies still works.
        if (r.session) session.set(r.session);
        await api("/api/me"); // proves the session actually sticks on this device
        let hidden = false;
        try { hidden = localStorage.getItem(HIDE_KEY) === "1"; } catch { /* ignore */ }
        if (hidden) nav("/", { replace: true });
        else setWelcome(r.label);
      } catch (e) {
        setError(e instanceof ApiError ? { message: e.message, code: e.code } : { message: "Couldn't reach the server. Check you're on the same network, or that the address is right." });
      }
    })();
  }, [token, nav]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 px-6 text-center">
      <LogoMark size={56} />
      {welcome !== null && !error ? (
        <div className="w-full max-w-sm animate-rise">
          <h1 className="font-display text-3xl font-bold tracking-tight">Welcome, {welcome}</h1>
          <p className="mt-2 text-bone-dim">Pick something and press play. Your progress is saved on this link.</p>
          <button className="btn-primary mt-6 w-full !py-3" onClick={enter} autoFocus>Start watching</button>
          <label className="mt-4 flex cursor-pointer items-center justify-center gap-2 text-sm text-bone-mute">
            <input type="checkbox" checked={hide} onChange={(e) => setHide(e.target.checked)} className="size-4 accent-[#9b8cff]" />
            Don't show this again
          </label>
        </div>
      ) : error ? (
        <>
          <h1 className="font-display text-3xl font-bold tracking-tight">That link didn't work</h1>
          <p className="max-w-sm text-bone-dim">{error.message}</p>
          <p className="max-w-sm text-xs text-bone-mute">
            {device().label} · {error.code ?? "network"}. {error.code === "DEVICE_LIMIT" ? "" : <>If you opened this from a chat app, open it in Safari or Chrome instead. Otherwise ask for a fresh link.</>}
          </p>
        </>
      ) : (
        <p className="text-bone-dim">Taking you in…</p>
      )}
    </div>
  );
}
