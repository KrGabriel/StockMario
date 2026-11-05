import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import type { Movement, Technician, Material, ReturnFlowRow, WithdrawalFlowRow } from "../../lib/types";
import { formatDateTime, formatQty, errorMessage } from "../../lib/format";
import { historyToCsv, downloadCsv, toCsv } from "../../lib/csv";
import { iclassOf } from "../../lib/types";
import PhotoPreview from "./PhotoPreview";

const PAGE_SIZE = 50;
const MOVEMENT_SELECT =
  "id, technician_id, material_id, movement_type, quantity, notes, created_by, created_at, idempotency_key, photo_path, iclass_confirmations ( confirmed_at, confirmed_by, profiles ( email ) )";

const STATUS_LABEL: Record<string, string> = {
  pending: "Pendiente",
  approved: "Aprobada",
  rejected: "Rechazada",
  corrected: "Corregida",
};

const WITHDRAWAL_STATUS_LABEL: Record<string, string> = {
  pending: "Pendiente",
  approved: "Aprobado",
  rejected: "Rechazado",
  corrected: "Corregido",
};

const WITHDRAWAL_REASON_LABEL: Record<string, string> = {
  nothing_withdrawn: "No se retiró nada",
  different_material_withdrawn: "Se retiró otro material",
};

function withdrawalsToCsv(rows: WithdrawalFlowRow[]): string {
  const header = [
    "Fecha solicitud",
    "Técnico",
    "Material declarado",
    "Cantidad declarada",
    "Unidad",
    "Estado",
    "Material real",
    "Cantidad real",
    "Observaciones técnico",
    "Resuelto por",
    "Fecha resolución",
    "Motivo / nota del administrador",
  ];
  const body = rows.map((r) => [
    formatDateTime(r.requested_at),
    r.technician_name,
    r.declared_material_name,
    r.declared_quantity,
    r.declared_unit,
    WITHDRAWAL_STATUS_LABEL[r.status] ?? r.status,
    r.corrected_material_name ?? "",
    r.corrected_quantity ?? "",
    r.notes ?? "",
    r.resolver_email ?? "",
    r.resolved_at ? formatDateTime(r.resolved_at) : "",
    [WITHDRAWAL_REASON_LABEL[r.resolution_reason ?? ""], r.admin_notes]
      .filter((x) => x)
      .join(" — "),
  ]);
  return toCsv([header, ...body]);
}

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
  const [iclassFilter, setIclassFilter] = useState<"pending" | "confirmed" | "">("pending");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [movements, setMovements] = useState<Movement[]>([]);
  const [returnFlow, setReturnFlow] = useState<ReturnFlowRow[]>([]);
  const [withdrawalFlow, setWithdrawalFlow] = useState<WithdrawalFlowRow[]>([]);
  const [count, setCount] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmIclass, setConfirmIclass] = useState(false);
  const [iclassBusy, setIclassBusy] = useState(false);

  const returnMode = typeFilter === "return";
  const withdrawalMode = typeFilter === "withdrawal";

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
        if (withdrawalMode) {
          // Historial de retiros: solicitudes (todas sus resoluciones) +
          // retiros efectivos históricos sin duplicar los derivados de solicitudes
          let q = supabase
            .from("v_withdrawal_flow")
            .select(
              "id, source, technician_id, technician_name, declared_material_id, declared_material_name, declared_material_code, declared_unit, declared_quantity, photo_path, status, resolution_reason, corrected_material_id, corrected_material_name, corrected_material_code, corrected_unit, corrected_quantity, notes, resolved_by, resolver_email, resolved_at, admin_notes, requested_at, movement_id",
              { count: "exact" },
            )
            .order("requested_at", { ascending: false })
            .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
          if (techFilter) q = q.eq("technician_id", techFilter);
          if (matFilter) q = q.eq("declared_material_id", matFilter);
          if (statusFilter) q = q.eq("status", statusFilter);
          if (dateFrom) q = q.gte("requested_at", `${dateFrom}T00:00:00`);
          if (dateTo) q = q.lte("requested_at", `${dateTo}T23:59:59`);
          const { data, error: qError, count: qCount } = await q;
          if (qError) throw qError;
          setWithdrawalFlow((data ?? []) as WithdrawalFlowRow[]);
          setCount(qCount ?? 0);
        } else if (returnMode) {
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
          // Historial de movimientos efectivos (retiros y devoluciones efectivas),
          // con el estado de subida a ICLASS (pendientes por defecto).
          let query = supabase
            .from("movements")
            .select(MOVEMENT_SELECT, { count: "exact" })
            .order("created_at", { ascending: false })
            .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
          if (techFilter) query = query.eq("technician_id", techFilter);
          if (matFilter) query = query.eq("material_id", matFilter);
          if (typeFilter) query = query.eq("movement_type", typeFilter);
          if (iclassFilter === "pending") query = query.is("iclass_confirmations", null);
          if (iclassFilter === "confirmed") query = query.not("iclass_confirmations", "is", null);
          if (dateFrom) query = query.gte("created_at", `${dateFrom}T00:00:00`);
          if (dateTo) query = query.lte("created_at", `${dateTo}T23:59:59`);
          const { data, error: qError, count: qCount } = await query;
          if (qError) throw qError;
          setMovements((data ?? []) as unknown as Movement[]);
          setCount(qCount ?? 0);
        }
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [returnMode, withdrawalMode, techFilter, matFilter, typeFilter, statusFilter, iclassFilter, dateFrom, dateTo, page]);

  function exportCsv() {
    if (withdrawalMode) {
      downloadCsv(
        `historial-retiros-${new Date().toISOString().slice(0, 10)}.csv`,
        withdrawalsToCsv(withdrawalFlow),
      );
    } else if (returnMode) {
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
  const visibleIds = movements.map((m) => m.id);
  const selectedCount = [...selected].filter((id) => visibleIds.includes(id)).length;

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      const allVisible = visibleIds.every((id) => next.has(id));
      for (const id of visibleIds) {
        if (allVisible) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  async function confirmIclassUpload() {
    setIclassBusy(true);
    setError("");
    setNotice("");
    try {
      const ids = [...selected].filter((id) => visibleIds.includes(id));
      const { data, error: rpcError } = await supabase.rpc("confirm_iclass_upload", {
        p_movement_ids: ids,
      });
      if (rpcError) throw rpcError;
      setSelected(new Set());
      setConfirmIclass(false);
      setNotice(
        `Subida a ICLASS confirmada por ${data ?? 0} movimiento(s). Ya no aparecen en la lista de pendientes.`,
      );
      setPage(0);
    } catch (e) {
      setConfirmIclass(false);
      setError(errorMessage(e));
    } finally {
      setIclassBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {notice && (
        <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{notice}</div>
      )}
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
          <select className="input !py-2" value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value); setStatusFilter(""); setPage(0); }}>
            <option value="">Todos</option>
            <option value="withdrawal">Retiros</option>
            <option value="return">Devoluciones</option>
          </select>
        </div>
        {(returnMode || withdrawalMode) && (
          <div>
            <label className="label">{returnMode ? "Estado devolución" : "Estado retiro"}</label>
            <select className="input !py-2" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(0); }}>
              <option value="">Todos</option>
              <option value="pending">Pendientes</option>
              <option value="approved">Aprobados</option>
              <option value="rejected">Rechazados</option>
              {withdrawalMode && <option value="corrected">Corregidos</option>}
            </select>
          </div>
        )}
        {!returnMode && !withdrawalMode && (
          <div>
            <label className="label">Subida a ICLASS</label>
            <select className="input !py-2" value={iclassFilter} onChange={(e) => { setIclassFilter(e.target.value as "pending" | "confirmed" | ""); setPage(0); }}>
              <option value="pending">Pendientes</option>
              <option value="confirmed">Confirmados</option>
              <option value="">Todos</option>
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
            {withdrawalMode ? "Retiros y solicitudes" : returnMode ? "Devoluciones y solicitudes" : "Movimientos"} ({count})
          </h2>
          <button
            onClick={exportCsv}
            className="btn-secondary"
            disabled={
              (withdrawalMode && withdrawalFlow.length === 0) ||
              (!returnMode && !withdrawalMode && movements.length === 0) ||
              (returnMode && returnFlow.length === 0)
            }
          >
            Exportar CSV
          </button>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}

        {withdrawalMode ? (
          <table className="min-w-full divide-y divide-slate-200">
            <thead>
              <tr>
                <th className="th">Solicitado</th>
                <th className="th">Técnico</th>
                <th className="th">Material declarado</th>
                <th className="th text-right">Cantidad declarada</th>
                <th className="th text-center">Estado</th>
                <th className="th">Material real</th>
                <th className="th text-right">Cantidad real</th>
                <th className="th">Foto</th>
                <th className="th">Observaciones</th>
                <th className="th">Resolución</th>
                <th className="th">Motivo / nota admin</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td className="td" colSpan={11}>Cargando…</td></tr>
              ) : withdrawalFlow.length === 0 ? (
                <tr><td className="td" colSpan={11}>No hay retiros con estos filtros.</td></tr>
              ) : (
                withdrawalFlow.map((r) => (
                  <tr key={`${r.source}-${r.id}`} className={r.status === "pending" ? "bg-amber-50/50" : ""}>
                    <td className="td whitespace-nowrap">{formatDateTime(r.requested_at)}</td>
                    <td className="td">{r.technician_name}</td>
                    <td className="td">
                      {r.declared_material_name}
                      <span className="text-xs text-slate-400"> {r.declared_material_code}</span>
                    </td>
                    <td className="td text-right font-medium">
                      {formatQty(r.declared_quantity)} {r.declared_unit}
                    </td>
                    <td className="td text-center">
                      <span
                        className={`badge ${
                          r.status === "pending"
                            ? "bg-amber-100 text-amber-700"
                            : r.status === "approved"
                              ? "bg-green-100 text-green-700"
                              : r.status === "corrected"
                                ? "bg-sky-100 text-sky-700"
                                : "bg-red-100 text-red-700"
                        }`}
                      >
                        {WITHDRAWAL_STATUS_LABEL[r.status] ?? r.status}
                      </span>
                    </td>
                    <td className="td">
                      {r.corrected_material_name
                        ? `${r.corrected_material_name}${r.corrected_material_code ? ` ${r.corrected_material_code}` : ""}`
                        : r.status === "rejected"
                          ? "—"
                          : "-"}
                    </td>
                    <td className="td text-right">
                      {r.corrected_quantity
                        ? `${formatQty(r.corrected_quantity)} ${r.corrected_unit ?? ""}`
                        : "-"}
                    </td>
                    <td className="td">
                      {r.photo_path ? (
                        <button
                          onClick={() =>
                            setPhotoVer({
                              movement: {
                                id: r.movement_id ?? r.id,
                                technician_id: r.technician_id,
                                material_id: r.declared_material_id,
                                movement_type: "withdrawal",
                                quantity: r.declared_quantity,
                                notes: r.notes,
                                created_by: r.resolved_by,
                                created_at: r.requested_at,
                                idempotency_key: null,
                                photo_path: r.photo_path,
                              },
                            })
                          }
                          className="text-violet-600 underline hover:text-violet-800"
                          title={r.photo_path}
                        >
                          📷 Ver
                        </button>
                      ) : (
                        <span className="text-xs text-slate-300">—</span>
                      )}
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
                      {[
                        WITHDRAWAL_REASON_LABEL[r.resolution_reason ?? ""] ?? "",
                        r.admin_notes,
                      ]
                        .filter((x) => x)
                        .join(" — ") || "-"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        ) : returnMode ? (
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
          <>
            <div className="mb-3 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3">
              <button
                onClick={() => setConfirmIclass(true)}
                className="btn-primary !w-auto"
                disabled={selectedCount === 0 || iclassBusy}
              >
                CONFIRMAR SUBIDA A ICLASS{selectedCount > 0 ? ` (${selectedCount})` : ""}
              </button>
              <span className="text-xs text-slate-500">
                Marcá los movimientos verificándolos y confirmalos: se registran con tu usuario y
                fecha, y dejan de aparecer como pendientes de carga.
              </span>
            </div>
            <table className="min-w-full divide-y divide-slate-200">
              <thead>
                <tr>
                  <th className="th text-center">
                    <input
                      type="checkbox"
                      aria-label="Seleccionar todo lo visible"
                      checked={visibleIds.length > 0 && visibleIds.every((id) => selected.has(id))}
                      onChange={toggleAllVisible}
                      className="h-4 w-4"
                    />
                  </th>
                  <th className="th">Fecha</th>
                  <th className="th">Hora</th>
                  <th className="th">Técnico</th>
                  <th className="th">Material</th>
                  <th className="th text-right">Cantidad</th>
                  <th className="th">Movimiento</th>
                  <th className="th">Foto</th>
                  <th className="th">Observaciones</th>
                  <th className="th">ICLASS</th>
                </tr>
              </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td className="td" colSpan={10}>Cargando…</td></tr>
              ) : movements.length === 0 ? (
                <tr><td className="td" colSpan={10}>No hay movimientos con estos filtros.</td></tr>
              ) : (
                movements.map((mv) => {
                  const m = matMap.get(mv.material_id);
                  const confirmed = iclassOf(mv.iclass_confirmations);
                  return (
                    <tr key={mv.id}>
                      <td className="td text-center">
                        <input
                          type="checkbox"
                          aria-label={`Seleccionar movimiento del ${formatDateTime(mv.created_at)}`}
                          checked={selected.has(mv.id)}
                          onChange={() => toggleRow(mv.id)}
                          className="h-4 w-4"
                        />
                      </td>
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
                      <td className="td whitespace-nowrap" title={confirmed ? `${confirmed.profiles?.email ?? "-"} · ${formatDateTime(confirmed.confirmed_at)}` : "Pendiente de subida a ICLASS"}>
                        {confirmed ? (
                          <span className="badge bg-green-100 text-green-700">
                            ✓ {formatDateTime(confirmed.confirmed_at)}
                          </span>
                        ) : (
                          <span className="badge bg-amber-100 text-amber-700">Pendiente</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
          </>
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

      {confirmIclass && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 md:items-center" onClick={() => setConfirmIclass(false)}>
          <div className="card w-full max-w-md space-y-4 !p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold">¿Confirmar subida a ICLASS?</h3>
            <p className="text-sm text-slate-600">
              Vas a confirmar que {selectedCount} movimiento(s) ya fueron cargados en ICLASS. Se
              registrará tu usuario y la fecha/hora de la confirmación, y dejarán de aparecer en la
              lista de pendientes. Los movimientos no se borran ni se modifican.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmIclass(false)} className="btn-secondary">
                Cancelar
              </button>
              <button onClick={confirmIclassUpload} className="btn-primary !w-auto" disabled={iclassBusy}>
                {iclassBusy ? "Procesando…" : "Confirmar subida a ICLASS"}
              </button>
            </div>
          </div>
        </div>
      )}

      {photoVer && (
        <PhotoPreview
          photoPath={photoVer.movement.photo_path!}
          createdAt={photoVer.movement.created_at}
          title={`Foto del retiro · ${technicians.find((t) => t.id === photoVer.movement.technician_id)?.full_name ?? "-"}`}
          subtitle={matMap.get(photoVer.movement.material_id)?.name ?? "-"}
          onClose={() => setPhotoVer(null)}
        />
      )}
    </div>
  );
}
