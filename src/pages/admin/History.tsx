import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import type { Movement, Technician, Material, ReturnFlowRow } from "../../lib/types";
import { formatDateTime, formatQty, errorMessage } from "../../lib/format";
import { historyToCsv, downloadCsv, toCsv } from "../../lib/csv";
import PhotoPreview from "./PhotoPreview";

const PAGE_SIZE = 50;

const STATUS_LABEL: Record<string, string> = {
  pending: "Pendiente",
  approved: "Aprobada",
  rejected: "Rechazada",
};

function returnsToCsv(rows: ReturnFlowRow[]): string {
  const header = [
    "Fecha solicitud",
    "Técnico",
    "Material",
    "Código",
    "Cantidad",
    "Unidad",
    "Estado",
    "Observaciones técnico",
    "Resuelta por",
    "Fecha resolución",
    "Motivo / nota del administrador",
  ];
  const body = rows.map((r) => [
    formatDateTime(r.requested_at),
    r.technician_name,
    r.material_name,
    r.material_code,
    r.quantity,
    r.unit,
    STATUS_LABEL[r.status] ?? r.status,
    r.notes ?? "",
    r.resolver_email ?? "",
    r.resolved_at ? formatDateTime(r.resolved_at) : "",
    r.admin_notes ?? "",
  ]);
  return toCsv([header, ...body]);
}

export default function History() {
  const [technicians, setTechnicians] = useState<Technician[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [photoVer, setPhotoVer] = useState<{ movement: Movement } | null>(null);

  const [techFilter, setTechFilter] = useState("");
  const [matFilter, setMatFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [movements, setMovements] = useState<Movement[]>([]);
  const [returnFlow, setReturnFlow] = useState<ReturnFlowRow[]>([]);
  const [count, setCount] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const returnMode = typeFilter === "return";

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
        if (returnMode) {
          // Historial de devoluciones: solicitudes (pendientes/rechazadas) y
          // devoluciones efectivas (aprobadas), sin duplicar las resueltas.
          let q = supabase
            .from("v_return_flow")
            .select("id, source, technician_id, technician_name, material_id, material_name, material_code, unit, quantity, notes, requested_at, status, resolved_by, resolver_email, resolved_at, admin_notes, photo_path", {
              count: "exact",
            })
            .order("requested_at", { ascending: false })
            .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
          if (techFilter) q = q.eq("technician_id", techFilter);
          if (matFilter) q = q.eq("material_id", matFilter);
          if (statusFilter) q = q.eq("status", statusFilter);
          if (dateFrom) q = q.gte("requested_at", `${dateFrom}T00:00:00`);
          if (dateTo) q = q.lte("requested_at", `${dateTo}T23:59:59`);
          const { data, error: qError, count: qCount } = await q;
          if (qError) throw qError;
          setReturnFlow((data ?? []) as ReturnFlowRow[]);
          setCount(qCount ?? 0);
        } else {
          // Historial de movimientos efectivos (retiros y aprobadas) — sin cambios
          let query = supabase
            .from("movements")
            .select("id, technician_id, material_id, movement_type, quantity, notes, created_by, created_at, idempotency_key, photo_path", {
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
        }
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [returnMode, techFilter, matFilter, typeFilter, statusFilter, dateFrom, dateTo, page]);

  function exportCsv() {
    if (returnMode) {
      downloadCsv(
        `historial-devoluciones-${new Date().toISOString().slice(0, 10)}.csv`,
        returnsToCsv(returnFlow),
      );
    } else {
      downloadCsv(
        `historial-movimientos-${new Date().toISOString().slice(0, 10)}.csv`,
        historyToCsv({ movements, technicians, materials }),
      );
    }
  }

  const matMap = new Map(materials.map((m) => [m.id, m]));
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
        {returnMode && (
          <div>
            <label className="label">Estado devolución</label>
            <select className="input !py-2" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(0); }}>
              <option value="">Todas</option>
              <option value="pending">Pendientes</option>
              <option value="approved">Aprobadas</option>
              <option value="rejected">Rechazadas</option>
            </select>
          </div>
        )}
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
          <h2 className="font-semibold text-slate-900">
            {returnMode ? "Devoluciones y solicitudes" : "Movimientos"} ({count})
          </h2>
          <button onClick={exportCsv} className="btn-secondary" disabled={(!returnMode && movements.length === 0) || (returnMode && returnFlow.length === 0)}>
            Exportar CSV
          </button>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}

        {returnMode ? (
          <table className="min-w-full divide-y divide-slate-200">
            <thead>
              <tr>
                <th className="th">Solicitada</th>
                <th className="th">Técnico</th>
                <th className="th">Material</th>
                <th className="th text-right">Cantidad</th>
                <th className="th text-center">Estado</th>
                <th className="th">Observaciones técnico</th>
                <th className="th">Resolvió</th>
                <th className="th">Motivo / nota admin</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td className="td" colSpan={8}>Cargando…</td></tr>
              ) : returnFlow.length === 0 ? (
                <tr><td className="td" colSpan={8}>No hay devoluciones con estos filtros.</td></tr>
              ) : (
                returnFlow.map((r: ReturnFlowRow) => (
                  <tr key={r.id} className={r.status === "pending" ? "bg-amber-50/50" : ""}>
                    <td className="td whitespace-nowrap">{formatDateTime(r.requested_at)}</td>
                    <td className="td">{r.technician_name}</td>
                    <td className="td">
                      {r.material_name}
                      <span className="text-xs text-slate-400"> {r.material_code}</span>
                    </td>
                    <td className="td text-right font-medium">
                      {formatQty(r.quantity)} {r.unit}
                    </td>
                    <td className="td text-center">
                      <span
                        className={`badge ${
                          r.status === "pending"
                            ? "bg-amber-100 text-amber-700"
                            : r.status === "approved"
                              ? "bg-green-100 text-green-700"
                              : "bg-red-100 text-red-700"
                        }`}
                      >
                        {STATUS_LABEL[r.status]}
                      </span>
                    </td>
                    <td className="td max-w-36 truncate" title={r.notes ?? ""}>
                      {r.notes ?? "-"}
                    </td>
                    <td className="td max-w-36 truncate" title={r.resolved_at ? `${r.resolver_email ?? "-"} · ${formatDateTime(r.resolved_at)}` : ""}>
                      {r.resolved_at
                        ? `${r.resolver_email ?? "-"} · ${formatDateTime(r.resolved_at)}`
                        : "-"}
                    </td>
                    <td className="td max-w-36 truncate" title={r.admin_notes ?? ""}>
                      {r.admin_notes ?? "-"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        ) : (
          <table className="min-w-full divide-y divide-slate-200">
            <thead>
              <tr>
                <th className="th">Fecha</th>
                <th className="th">Hora</th>
                <th className="th">Técnico</th>
                <th className="th">Material</th>
                <th className="th text-right">Cantidad</th>
                <th className="th">Movimiento</th>
                <th className="th">Foto</th>
                <th className="th">Observaciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td className="td" colSpan={8}>Cargando…</td></tr>
              ) : movements.length === 0 ? (
                <tr><td className="td" colSpan={8}>No hay movimientos con estos filtros.</td></tr>
              ) : (
                movements.map((mv) => {
                  const m = matMap.get(mv.material_id);
                  return (
                    <tr key={mv.id}>
                      <td className="td whitespace-nowrap">{formatDateTime(mv.created_at).split(",")[0]}</td>
                      <td className="td whitespace-nowrap">{formatDateTime(mv.created_at).split(", ")[1] ?? ""}</td>
                      <td className="td">{technicians.find((t) => t.id === mv.technician_id)?.full_name ?? "-"}</td>
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
                      <td className="td">
                        {mv.photo_path ? (
                          <button onClick={() => setPhotoVer({ movement: mv })} className="text-violet-600 underline hover:text-violet-800" title={mv.photo_path}>
                            📷 Ver
                          </button>
                        ) : (
                          <span className="text-xs text-slate-300">—</span>
                        )}
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
        )}

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

      {photoVer && (
        <PhotoPreview movement={photoVer.movement} techName={technicians.find((t) => t.id === photoVer.movement.technician_id)?.full_name ?? "-"} matName={matMap.get(photoVer.movement.material_id)?.name ?? "-"} onClose={() => setPhotoVer(null)} />
      )}
    </div>
  );
}
