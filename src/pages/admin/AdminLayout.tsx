import { useEffect, useState } from "react";
import { NavLink, Navigate, Outlet, useNavigate } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../../lib/supabase";

const NAV = [
  { to: "/admin", label: "Dashboard", end: true },
  { to: "/admin/historial", label: "Historial" },
  { to: "/admin/resumenes", label: "Resumen de movimientos" },
  { to: "/admin/pendientes", label: "Pendientes" },
  { to: "/admin/materiales", label: "Materiales" },
  { to: "/admin/tecnicos", label: "Técnicos" },
];

export default function AdminLayout() {
  const navigate = useNavigate();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    return () => subscription.unsubscribe();
  }, []);

  async function signOut() {
    await supabase.auth.signOut();
    navigate("/admin/login", { replace: true });
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-500">
        Cargando…
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/admin/login" replace />;
  }

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-brand-600">
              Depósito SwissNet
            </p>
            <h1 className="text-base font-bold text-slate-900">Panel administrativo</h1>
          </div>
          <button onClick={signOut} className="btn-secondary">
            Salir
          </button>
        </div>
        <nav className="mx-auto max-w-6xl overflow-x-auto px-2 pb-2">
          <ul className="flex space-x-1 text-sm">
            {NAV.map(({ to, label, end }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  end={end}
                  className={({ isActive }) =>
                    `whitespace-nowrap rounded-lg px-3 py-1.5 font-medium transition ${
                      isActive
                        ? "bg-brand-600 text-white"
                        : "text-slate-600 hover:bg-slate-100"
                    }`
                  }
                >
                  {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main className="mx-auto max-w-6xl p-4">
        <Outlet />
      </main>
    </div>
  );
}
