import { useCallback, useEffect, useState } from "react";
import { NavLink, Navigate, Outlet, useNavigate } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../../lib/supabase";

const NAV = [
  { to: "/admin", label: "Dashboard", end: true },
  { to: "/admin/historial", label: "Historial" },
  { to: "/admin/resumenes", label: "Resumen de movimientos" },
  { to: "/admin/pendientes", label: "Pendientes" },
  { to: "/admin/retiros", label: "Retiros pendientes" },
  { to: "/admin/devoluciones", label: "Devoluciones pendientes" },
  { to: "/admin/materiales", label: "Materiales" },
  { to: "/admin/tecnicos", label: "Técnicos" },
];

export default function AdminLayout() {
  const navigate = useNavigate();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingReturns, setPendingReturns] = useState(0);
  const [pendingWithdrawals, setPendingWithdrawals] = useState(0);

  // Indicador visible de solicitudes de devolución pendientes
  const fetchPendingReturns = useCallback(async () => {
    const { count } = await supabase
      .from("return_requests")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending");
    setPendingReturns(count ?? 0);
  }, []);

  // Indicador visible de solicitudes de retiro pendientes
  const fetchPendingWithdrawals = useCallback(async () => {
    const { count } = await supabase
      .from("withdrawal_requests")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending");
    setPendingWithdrawals(count ?? 0);
  }, []);

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

  useEffect(() => {
    if (!session) return;
    fetchPendingReturns();
    fetchPendingWithdrawals();
    const interval = window.setInterval(fetchPendingReturns, 45_000);
    const intervalW = window.setInterval(fetchPendingWithdrawals, 45_000);
    window.addEventListener("return-requests-updated", fetchPendingReturns);
    window.addEventListener("withdrawal-requests-updated", fetchPendingWithdrawals);
    return () => {
      window.clearInterval(interval);
      window.clearInterval(intervalW);
      window.removeEventListener("return-requests-updated", fetchPendingReturns);
      window.removeEventListener("withdrawal-requests-updated", fetchPendingWithdrawals);
    };
  }, [session, fetchPendingReturns, fetchPendingWithdrawals]);

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
                  {to === "/admin/devoluciones" && pendingReturns > 0 && (
                    <span className="ml-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1.5 text-[11px] font-bold text-white">
                      {pendingReturns}
                    </span>
                  )}
                  {to === "/admin/retiros" && pendingWithdrawals > 0 && (
                    <span className="ml-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1.5 text-[11px] font-bold text-white">
                      {pendingWithdrawals}
                    </span>
                  )}
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
