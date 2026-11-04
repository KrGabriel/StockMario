import { Fragment, useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabase";
import type { Movement, Material, Technician } from "../../lib/types";
import { formatDateTime, formatQty, errorMessage } from "../../lib/format";

type Tab = "material" | "technician" | "pending";

interface MaterialAgg {
  material: Material;
  withdrawn: number;
  returned: number;
  net: number;
  rows: { date: string; tech: string; type: string; qty: number; notes: string | null }[];
}

interface TechAgg {
  name: string;
  withdrawn: number;
  returned: number;
  net: number;
}

interface PendingTechAgg {
  techName: string;
  material: string;
  withdrawn: number;
  returned: number;
  pending: number;
  oldestAt: string;
}

export default function Summaries() {
  const [tab, setTab] = useState<Tab>("material");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [category, setCategory] = useState("");
  const [movType, setMovType] = useState("");

  const [materials, setMaterials] = useState<Material[]>([]);
  const [technicians, setTechnicians] = useState<Technician[]>([]);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [pending, setPending] = useState<PendingTechAgg[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [openMaterial, setOpenMaterial] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [matRes, techRes] = await Promise.all([
        supabase.from("materials").select("*").order("name"),
        supabase.from("technicians").select("*").order("full_name"),
      ]);
      if (matRes.error) setError(matRes.error.message);
      if (techRes.error) setError(techRes.error.message);
      setMaterials((matRes.data ?? []) as Material[]);
      setTechnicians((techRes.data ?? []) as Technician[]);
    })();
  }, []);

  useEffect(() => {
    (async () => {
      if (tab === "pending") {
        setLoading(true);
        try {
          const { data, error: qError } = await supabase
            .from("v_pending_withdrawals")
            .select("*")
            .order("withdrawn_at", { ascending: true });
          if (qError) throw qError;
          const agg = new Map<string, PendingTechAgg>();
          for (const p of data ?? []) {
            const key = `${p.technician_name}|${p.material_name}`;
            const cur = agg.get(key);
            if (cur) {
              cur.withdrawn += p.withdrawn_qty;
              cur.returned += p.returned_qty;
              cur.pending += p.pending_qty;
            } else {
              agg.set(key, {
                techName: p.technician_name,
                material: p.material_name,
                withdrawn: p.withdrawn_qty,
                returned: p.returned_qty,
                pending: p.pending_qty,
                oldestAt: p.withdrawn_at,
              });
            }
          }
          setPending([...agg.values()].sort((a, b) => a.oldestAt.localeCompare(b.oldestAt)));
        } catch (e) {
          setError(errorMessage(e));
        } finally {
          setLoading(false);
        }
        return;
      }

      setLoading(true);
      setError("");
      try {
        let query = supabase
          .from("movements")
          .select("id, technician_id, material_id, movement_type, quantity, notes, created_at");
        if (dateFrom) query = query.gte("created_at", `${dateFrom}T00:00:00`);
        if (dateTo) query = query.lte("created_at", `${dateTo}T23:59:59`);
        if (movType) query = query.eq("movement_type", movType);
        query = query.order("created_at", { ascending: true });
        const { data, error: qError } = await query;
        if (qError) throw qError;
        setMovements((data ?? []) as Movement[]);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [tab, dateFrom, dateTo, movType]);

  const techMap = useMemo(
    () => new Map(technicians.map((t) => [t.id, t.full_name])),
    [technicians],
  );

  const byMaterial = useMemo<MaterialAgg[]>(() => {
    const cats = category ? new Set([category]) : null;
    const filtered = movements.filter((mv) => cats?.has(materials.find((m) => m.id === mv.material_id)?.category ?? "") ?? true);
    const map = new Map<string, MaterialAgg>();
    for (const mv of filtered) {
      const mat = materials.find((m) => m.id === mv.material_id);
      if (!mat) continue;
      if (!cats || cats.has(mat.category ?? "")) {
        let agg = map.get(mat.id);
        if (!agg) {
          agg = { material: mat, withdrawn: 0, returned: 0, net: 0, rows: [] };
          map.set(mat.id, agg);
        }
        if (mv.movement_type === "withdrawal") agg.withdrawn += mv.quantity;
        else agg.returned += mv.quantity;
        agg.net = agg.withdrawn - agg.returned;
        agg.rows.push({
          date: mv.created_at,
          tech: techMap.get(mv.technician_id) ?? "-",
          type: mv.movement_type === "withdrawal" ? "Retiro" : "Devolución",
          qty: mv.quantity,
          notes: mv.notes,
        });
      }
    }
    return [...map.values()].sort((a, b) => b.net - a.net);
  }, [movements, materials, category, techMap]);

  const groupedByTechAgg = useMemo<TechAgg[]>(() => {
    const map = new Map<string, TechAgg>();
    for (const mv of movements) {
      const name = techMap.get(mv.technician_id) ?? "-";
      if (category && materials.find((m) => m.id === mv.material_id)?.category !== category) continue;
      let agg = map.get(name);
      if (!agg) {
        agg = { name, withdrawn: 0, returned: 0, net: 0 };
        map.set(name, agg);
      }
      if (mv.movement_type === "withdrawal") agg.withdrawn += mv.quantity;
      else agg.returned += mv.quantity;
      agg.net = agg.withdrawn - agg.returned;
    }
    return [...map.values()].sort((a, b) => b.net - a.net);
  }, [movements, techMap, category, materials]);

  const categories = useMemo(
    () => [...new Set(materials.map((m) => m.category).filter((c): c is string => !!c))].sort(),
    [materials],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1">
        {(
          [
            ["material", "Por material"],
            ["technician", "Por técnico"],
            ["pending", "Pendientes por técnico"],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${
              tab === id ? "bg-brand-600 text-white" : "bg-white text-slate-600 shadow-sm"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab !== "pending" && (
        <div className="card grid grid-cols-2 gap-3 md:grid-cols-4">
          <div>
            <label className="label">Desde</label>
            <input type="date" className="input !py-2" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </div>
          <div>
            <label className="label">Hasta</label>
            <input type="date" className="input !py-2" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </div>
          <div>
            <label className="label">Categoría</label>
            <select className="input !py-2" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">Todas</option>
              {categories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Movimientos incluidos</label>
            <select className="input !py-2" value={movType} onChange={(e) => setMovType(e.target.value)}>
              <option value="">Retiros y devoluciones</option>
              <option value="withdrawal">Solo retiros</option>
              <option value="return">Solo devoluciones</option>
            </select>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
      {loading && <p className="text-sm text-slate-500">Cargando…</p>}

      {!loading && tab === "material" && (
        <div className="card overflow-x-auto">
          <h2 className="mb-2 font-semibold text-slate-900">
            SALIDA NETA = TOTAL RETIRADO − TOTAL DEVUELTO
          </h2>
          <table className="min-w-full divide-y divide-slate-200">
            <thead>
              <tr>
                <th className="th">Material</th>
                <th className="th text-right">Retirado</th>
                <th className="th text-right">Devuelto</th>
                <th className="th text-right">Salida neta</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {byMaterial.length === 0 ? (
                <tr><td className="td" colSpan={5}>Sin movimientos en el período.</td></tr>
              ) : (
                byMaterial.map((a) => (
                  <Fragment key={a.material.id}>
                    <tr className={openMaterial === a.material.id ? "bg-slate-50" : ""}>
                      <td className="td">
                        {a.material.name}
                        <span className="text-xs text-slate-400"> {a.material.code}</span>
                      </td>
                      <td className="td text-right">{formatQty(a.withdrawn)} {a.material.unit}</td>
                      <td className="td text-right">{formatQty(a.returned)} {a.material.unit}</td>
                      <td className="td text-right font-bold">{formatQty(a.net)} {a.material.unit}</td>
                      <td className="td">
                        <button className="text-xs text-brand-600 underline" onClick={() => setOpenMaterial(openMaterial === a.material.id ? null : a.material.id)}>
                          {openMaterial === a.material.id ? "Ocultar historial" : "Historial"}
                        </button>
                      </td>
                    </tr>
                    {openMaterial === a.material.id && (
                      <tr className="bg-slate-50">
                        <td colSpan={5} className="px-6 py-3">
                          <ul className="space-y-1 text-sm text-slate-700">
                            {a.rows.map((r, i) => (
                              <li key={i}>
                                {formatDateTime(r.date)} · {r.tech} · {r.type}: {formatQty(r.qty)} {a.material.unit}
                                {r.notes ? ` (${r.notes})` : ""}
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {!loading && tab === "technician" && (
        <div className="card overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead>
              <tr>
                <th className="th">Técnico</th>
                <th className="th text-right">Total retirado</th>
                <th className="th text-right">Total devuelto</th>
                <th className="th text-right">Salida neta</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {groupedByTechAgg.length === 0 ? (
                <tr><td className="td" colSpan={4}>Sin movimientos en el período.</td></tr>
              ) : (
                groupedByTechAgg.map((a) => (
                  <tr key={a.name}>
                    <td className="td font-medium">{a.name}</td>
                    <td className="td text-right">{formatQty(a.withdrawn)}</td>
                    <td className="td text-right">{formatQty(a.returned)}</td>
                    <td className="td text-right font-bold">{formatQty(a.net)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {!loading && tab === "pending" && (
        <div className="card overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead>
              <tr>
                <th className="th">Técnico</th>
                <th className="th">Material</th>
                <th className="th text-right">Retirado</th>
                <th className="th text-right">Devuelto</th>
                <th className="th text-right">Pendiente</th>
                <th className="th">Retiro más antiguo</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pending.length === 0 ? (
                <tr><td className="td" colSpan={6}>No hay herramientas pendientes de devolución.</td></tr>
              ) : (
                pending.map((p, i) => (
                  <tr key={i}>
                    <td className="td font-medium">{p.techName}</td>
                    <td className="td">{p.material}</td>
                    <td className="td text-right">{formatQty(p.withdrawn)}</td>
                    <td className="td text-right">{formatQty(p.returned)}</td>
                    <td className="td text-right font-bold text-violet-700">{formatQty(p.pending)}</td>
                    <td className="td whitespace-nowrap">{formatDateTime(p.oldestAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
