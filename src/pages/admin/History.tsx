import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import type { Movement, Technician, Material } from "../../lib/types";
import { formatDateTime, formatQty, errorMessage } from "../../lib/format";
import { historyToCsv, downloadCsv } from "../../lib/csv";

const PAGE_SIZE = 50;

export default function History() {
  const [technicians, setTechnicians] = useState<Technician[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);

  const [techFilter, setTechFilter] = useState("");
  const [matFilter, setMatFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [movements, setMovements] = useState<Movement[]>([]);
  const [count, setCount] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      const [techRes, matRes] = await Promise.all([
        supabase.from("technicians").select("*").order("full_name"),
        supabase.from("materials").select("*").order("name"),
      ]);
      if (techRes.error) setError(techRes.error.message);
      if (matRes.error) setError(matRes.error.message);
      setTechnicians((techRes.data ?? []) as Technician[]);
      setMaterials((matRes.data ?? []) as Material[]);
    })();
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError("");
      try {
        let query = supabase
          .from("movements")
          .select("id, technician_id, material_id, movement_type, quantity, notes, created_by, created_at, idempotency_key", {
            count: "exact",
          })
          .order("created_at", { ascending: false })
          .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
        if (techFilter) query = query.eq("technician_id", techFilter);
        if (matFilter) query = query.eq("material_id", matFilter);
        if (typeFilter) query = query.eq("movement_type", typeFilter);
        if (dateFrom) query = query.gte("created_at", `${dateFrom}T00:00:00`);
        if (dateTo) query = query.lte("created_at", `${dateTo}T23:59:59`);
        const { data, error: qError, count: qCount } = await query;
        if (qError) throw qError;
        setMovements((data ?? []) as Movement[]);
        setCount(qCount ?? 0);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [techFilter, matFilter, typeFilter, dateFrom, dateTo, page]);

  function exportCsv() {
    const csv = historyToCsv({ movements, technicians, materials });
    downloadCsv(`historial-movimientos-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  }

  const matMap = new Map(materials.map((m) => [m.id, m]));
  const techMap = new Map(technicians.map((t) => [t.id, t.full_name]));
  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div className="card grid grid-cols-2 gap-3 md:grid-cols-5">
        <div>
          <label className="label">Técnico</label>
          <select className="input !py-2" value={techFilter} onChange={(e) => { setTechFilter(e.target.value); setPage(0); }}>
            <option value="">Todos</option>
            {technicians.map((t) => (
              <option key={t.id} value={t.id}>{t.full_name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Material</label>
          <select className="input !py-2" value={matFilter} onChange={(e) => { setMatFilter(e.target.value); setPage(0); }}>
            <option value="">Todos</option>
            {materials.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Tipo</label>
          <select className="input !py-2" value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value); setPage(0); }}>
            <option value="">Todos</option>
            <option value="withdrawal">Retiros</option>
            <option value="return">Devoluciones</option>
          </select>
        </div>
        <div>
          <label className="label">Desde</label>
          <input type="date" className="input !py-2" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(0); }} />
        </div>
        <div>
          <label className="label">Hasta</label>
          <input type="date" className="input !py-2" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(0); }} />
        </div>
      </div>

      <div className="card overflow-x-auto">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold text-slate-900">Movimientos ({count})</h2>
          <button onClick={exportCsv} className="btn-secondary" disabled={movements.length === 0}>
            Exportar CSV
          </button>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <table className="min-w-full divide-y divide-slate-200">
          <thead>
            <tr>
              <th className="th">Fecha</th>
              <th className="th">Hora</th>
              <th className="th">Técnico</th>
              <th className="th">Material</th>
              <th className="th text-right">Cantidad</th>
              <th className="th">Movimiento</th>
              <th className="th">Observaciones</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr><td className="td" colSpan={7}>Cargando…</td></tr>
            ) : movements.length === 0 ? (
              <tr><td className="td" colSpan={7}>No hay movimientos con estos filtros.</td></tr>
            ) : (
              movements.map((mv) => {
                const m = matMap.get(mv.material_id);
                return (
                  <tr key={mv.id}>
                    <td className="td whitespace-nowrap">{formatDateTime(mv.created_at).split(",")[0]}</td>
                    <td className="td whitespace-nowrap">{formatDateTime(mv.created_at).split(", ")[1] ?? ""}</td>
                    <td className="td">{techMap.get(mv.technician_id) ?? "-"}</td>
                    <td className="td">
                      {m?.name ?? "-"}
                      <span className="text-xs text-slate-400"> {m?.code}</span>
                    </td>
                    <td className="td text-right font-medium">
                      {formatQty(mv.quantity)} {m?.unit}
                    </td>
                    <td className="td">
                      <span className={`badge ${mv.movement_type === "withdrawal" ? "bg-brand-100 text-brand-700" : "bg-green-100 text-green-700"}`}>
                        {mv.movement_type === "withdrawal" ? "Retiro" : "Devolución"}
                      </span>
                    </td>
                    <td className="td max-w-40 truncate" title={mv.notes ?? ""}>
                      {mv.notes ?? "-"}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
        {pages > 1 && (
          <div className="mt-3 flex items-center justify-between text-sm">
            <button className="btn-secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>
              Anterior
            </button>
            <span className="text-slate-500">
              Página {page + 1} de {pages}
            </span>
            <button className="btn-secondary" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
              Siguiente
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
