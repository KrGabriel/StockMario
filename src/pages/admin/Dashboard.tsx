import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import type { Movement, Technician, Material } from "../../lib/types";
import { formatDateTime, formatQty, errorMessage } from "../../lib/format";

interface Stats {
  materialsTotal: number;
  movementsTotal: number;
  withdrawals: number;
  returns: number;
  lowStock: number;
  outOfStock: number;
  pendingCount: number;
  pendingRequests: number;
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [lastMovements, setLastMovements] = useState<Movement[]>([]);
  const [techNames, setTechNames] = useState<Record<string, string>>({});
  const [matNames, setMatNames] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const [
          stockRes,
          movCountRes,
          wdCountRes,
          rtCountRes,
          pendingRes,
          pendingReqsRes,
          lastRes,
        ] = await Promise.all([
          supabase.from("v_material_stock").select("is_low_stock, is_out_of_stock, active"),
          supabase.from("movements").select("id", { count: "exact", head: true }),
          supabase
            .from("movements")
            .select("id", { count: "exact", head: true })
            .eq("movement_type", "withdrawal"),
          supabase
            .from("movements")
            .select("id", { count: "exact", head: true })
            .eq("movement_type", "return"),
          supabase.from("v_pending_withdrawals").select("id, pending_qty"),
          supabase
            .from("return_requests")
            .select("id", { count: "exact", head: true })
            .eq("status", "pending"),
          supabase
            .from("movements")
            .select("id, technician_id, material_id, movement_type, quantity, created_at, notes")
            .order("created_at", { ascending: false })
            .limit(8),
        ]);

        if (stockRes.error) throw stockRes.error;
        const stock = stockRes.data as { is_low_stock: boolean | null; is_out_of_stock: boolean | null; active: boolean }[];
        const stats: Stats = {
          materialsTotal: stock.filter((s) => s.active).length,
          movementsTotal: movCountRes.count ?? 0,
          withdrawals: wdCountRes.count ?? 0,
          returns: rtCountRes.count ?? 0,
          lowStock: stock.filter((s) => s.active && s.is_low_stock === true && !(s.is_out_of_stock === true)).length,
          outOfStock: stock.filter((s) => s.active && s.is_out_of_stock === true).length,
          pendingCount: (pendingRes.data ?? []).reduce((sum, p) => sum + p.pending_qty, 0),
          pendingRequests: pendingReqsRes.count ?? 0,
        };
        setStats(stats);

        if (lastRes.error) throw lastRes.error;
        const last = lastRes.data as (Movement & { notes?: string | null })[];
        setLastMovements(last as Movement[]);

        const techIds = [...new Set(last.map((m) => m.technician_id))];
        const matIds = [...new Set(last.map((m) => m.material_id))];
        const [techRes, matRes] = await Promise.all([
          supabase.from("technicians").select("id, full_name").in("id", techIds.length ? techIds : ["00000000-0000-0000-0000-000000000000"]),
          supabase.from("materials").select("id, name, unit").in("id", matIds.length ? matIds : ["00000000-0000-0000-0000-000000000000"]),
        ]);
        if (techRes.error) throw techRes.error;
        if (matRes.error) throw matRes.error;
        setTechNames(Object.fromEntries((techRes.data as Technician[]).map((t) => [t.id, t.full_name])));
        setMatNames(Object.fromEntries((matRes.data as (Material & { unit: string })[]).map((m) => [m.id, m.name])));
      } catch (e) {
        setError(errorMessage(e));
      }
    })();
  }, []);

  if (error) {
    return <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>;
  }

  const cards = [
    { label: "Materiales activos", value: stats ? formatQty(stats.materialsTotal) : "…" },
    { label: "Movimientos", value: stats ? formatQty(stats.movementsTotal) : "…" },
    { label: "Retiros", value: stats ? formatQty(stats.withdrawals) : "…", accent: "text-brand-600" },
    { label: "Devoluciones", value: stats ? formatQty(stats.returns) : "…", accent: "text-green-600" },
    { label: "Stock bajo", value: stats ? formatQty(stats.lowStock) : "…", accent: "text-amber-600" },
    { label: "Sin stock", value: stats ? formatQty(stats.outOfStock) : "…", accent: "text-red-600" },
    {
      label: "Pendiente de devolución (unidades fuera)",
      value: stats ? formatQty(stats.pendingCount) : "…",
      accent: "text-violet-600",
    },
    {
      label: "Devoluciones pendientes de aprobación",
      value: stats ? formatQty(stats.pendingRequests) : "…",
      accent: stats?.pendingRequests ? "text-amber-600" : "text-slate-900",
    },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="card">
            <p className="text-xs font-medium text-slate-500">{c.label}</p>
            <p className={`mt-1 text-2xl font-bold ${c.accent ?? "text-slate-900"}`}>{c.value}</p>
          </div>
        ))}
      </div>

      <section className="card">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold text-slate-900">Últimos movimientos</h2>
          <Link to="/admin/historial" className="text-sm text-brand-600 underline">
            Ver historial completo
          </Link>
        </div>
        {lastMovements.length === 0 ? (
          <p className="text-sm text-slate-500">Aún no hay movimientos registrados.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {lastMovements.map((m) => (
              <li key={m.id} className="flex items-center justify-between py-2.5 text-sm">
                <div>
                  <p className="font-medium text-slate-800">
                    {techNames[m.technician_id] ?? "(" + m.technician_id.slice(0, 8) + ")"}
                    {m.movement_type === "withdrawal" ? " retiró " : " devolvió "}
                    {matNames[m.material_id] ?? "(" + m.material_id.slice(0, 8) + ")"}
                  </p>
                  <p className="text-xs text-slate-500">
                    {formatDateTime(m.created_at)}
                    {m.movement_type === "withdrawal" ? " · Retiro" : " · Devolución"}
                  </p>
                </div>
                <span
                  className={`badge ${
                    m.movement_type === "withdrawal"
                      ? "bg-brand-100 text-brand-700"
                      : "bg-green-100 text-green-700"
                  }`}
                >
                  {formatQty(m.quantity)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
