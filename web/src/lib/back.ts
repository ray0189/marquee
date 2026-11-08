import { useNavigate } from "react-router-dom";

/** Back that never leaves the app: steps back through this app's own history (React Router numbers its
 *  entries in history.state.idx), or goes to `fallback` when the page was opened directly (shared link,
 *  new tab, home-screen app). `history.length` can't tell, since it counts other sites' pages too. */
export function useBack(fallback: string) {
  const nav = useNavigate();
  return () => ((window.history.state?.idx ?? 0) > 0 ? nav(-1) : nav(fallback, { replace: true }));
}
