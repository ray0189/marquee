import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { api, refreshUrlToken } from "./api";
import { LogoMark } from "./components/Logo";
import { Nav } from "./components/Nav";
import Browse from "./pages/Browse";
import Home from "./pages/Home";
import Join from "./pages/Join";
import NoAccess from "./pages/NoAccess";
import Title from "./pages/Title";

const Watch = lazy(() => import("./pages/Watch"));
const AdminApp = lazy(() => import("./pages/admin/AdminApp"));

function Splash() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <LogoMark size={60} />
    </div>
  );
}

/** Everything behind the invite link. */
function Protected() {
  const [label, setLabel] = useState<string | null>(null);
  const nav = useNavigate();
  const { pathname } = useLocation();

  useEffect(() => {
    api<{ label: string }>("/api/me")
      .then(async (m) => {
        await refreshUrlToken(); // before any page builds an EventSource or subtitle URL
        setLabel(m.label);
      })
      .catch(() => nav("/no-access", { replace: true }));
  }, [nav]);
  useEffect(() => {
    const deny = () => nav("/no-access", { replace: true });
    window.addEventListener("mq:noaccess", deny);
    return () => window.removeEventListener("mq:noaccess", deny);
  }, [nav]);

  if (label === null) return <Splash />;
  return (
    <>
      {!pathname.startsWith("/watch") && <Nav label={label} />}
      <Outlet />
    </>
  );
}

export default function App() {
  return (
    <div className="grain min-h-screen">
      <Suspense fallback={<Splash />}>
        <Routes>
          <Route path="/j/:token" element={<Join />} />
          <Route path="/no-access" element={<NoAccess />} />
          <Route path="/admin/*" element={<AdminApp />} />
          <Route element={<Protected />}>
            <Route path="/" element={<Home />} />
            <Route path="/browse/:type" element={<Browse />} />
            <Route path="/title/:type/:id" element={<Title />} />
            <Route path="/watch/:type/:id" element={<Watch />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </div>
  );
}
