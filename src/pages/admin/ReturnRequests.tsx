import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import type { ReturnRequest } from "../../lib/types";
import { formatDateTime, formatQty, errorMessage } from "../../lib/format";

type Action = { kind: "approve"; req: ReturnRequest } | { kind: "reject"; req: ReturnRequest } | null;

function notifyAdminBadge() {
  window.dispatchEvent(new CustomEvent("return-requests-updated"));
}

export default function ReturnRequests() {
  const [requests, setRequests] = useState<ReturnRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [acting, setActing] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Action>(null);
  const [rejectReason, setRejectReason] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await supabase
        .from("return_requests")
        .select("*, technicians ( full_name ), materials ( name, code, unit ), profiles ( email )")
        .eq("status", "pending")
        .order("requested_at", { ascending: true });
      if (res.error) throw res.error;
      setRequests((res.data ?? []) as ReturnRequest[]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function approveConfirm(req: ReturnRequest) {
    setActing(req.id);
    setError("");
    setNotice("");
    try {
      const { error: rpcError } = await supabase.rpc("approve_return_request", {
        p_request_id: req.id,
      });
      if (rpcError) throw rpcError;
      setNotice(
        `Devolución aprobada: ${formatQty(req.quantity)} ${(req.materials?.unit ?? "un")} de ${
          req.materials?.name ?? ""
        } de ${req.technicians?.full_name ?? ""}. Stock actualizado.`,
      );
      setConfirm(null);
      await load();
      notifyAdminBadge();
    } catch (e) {
      setConfirm(null);
      setError(
        `${errorMessage(e)} — Acción no realizada. Confirmá qué pasó antes de reintentar: si fue un error transitorio, podés reintentar la aprobación; si el inventario cambió, rechazá la solicitud o pedí a ${req.technicians?.full_name ?? "el técnico"} que la reenvíe.`,
      );
      await load();
    } finally {
      setActing(null);
    }
  }

  async function rejectConfirm(req: ReturnRequest) {
    if (!rejectReason.trim()) {
      setError("Ingresá el motivo del rechazo.");
      return;
    }
    setActing(req.id);
    setError("");
    setNotice("");
    try {
      const { error: rpcError } = await supabase.rpc("reject_return_request", {
        p_request_id: req.id,
        p_admin_notes: rejectReason.trim(),
      });
      if (rpcError) throw rpcError;
      setNotice(`Devolución rechazada. El stock no fue modificado.`);
      setConfirm(null);
      setRejectReason("");
      await load();
      notifyAdminBadge();
    } catch (e) {
      setConfirm(null);
      setError(errorMessage(e));
      await load();
    } finally {
      setActing(null);
    }
  }

  return (
    <div className="space-y-4">
      {notice && (
        <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{notice}</div>
      )}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      <div className="card">
        <h2 className="font-semibold text-slate-900">Devoluciones pendientes de aprobación ({requests.length})</h2>
        <p className="mt-1 text-sm text-slate-500">
          Las solicitudes pendientes no afectan el stock: solo pasan a contar cuando las aprobás.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-slate-500">Cargando…</p>
      ) : (
        <div className="card overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead>
              <tr>
                <th className="th">Solicitada</th>
                <th className="th">Técnico</th>
                <th className="th">Material</th>
                <th className="th text-right">Cantidad</th>
                <th className="th">Observaciones</th>
                <th className="th text-center">Estado</th>
                <th className="th">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {requests.length === 0 ? (
                <tr>
                  <td className="td" colSpan={7}>
                    No hay devoluciones pendientes de aprobación.
                  </td>
                </tr>
              ) : (
                requests.map((r) => (
                  <tr key={r.id}>
                    <td className="td whitespace-nowrap">{formatDateTime(r.requested_at)}</td>
                    <td className="td font-medium">{r.technicians?.full_name ?? "-"}</td>
                    <td className="td">
                      {r.materials?.name ?? "-"}
                      <span className="text-xs text-slate-400"> {r.materials?.code}</span>
                    </td>
                    <td className="td text-right">
                      {formatQty(r.quantity)} {r.materials?.unit}
                    </td>
                    <td className="td max-w-40 truncate" title={r.notes ?? ""}>
                      {r.notes ?? "-"}
                    </td>
                    <td className="td text-center">
                      <span className="badge bg-amber-100 text-amber-700">Pendiente</span>
                    </td>
                    <td className="td">
                      <div className="flex gap-2">
                        <button
                          onClick={() => setConfirm({ kind: "approve", req: r })}
                          className="btn-secondary !px-2 !py-1 !border-green-300 !text-green-700"
                          disabled={acting === r.id}
                        >
                          Aprobar
                        </button>
                        <button
                          onClick={() => setConfirm({ kind: "reject", req: r })}
                          className="btn-secondary !px-2 !py-1 !border-red-200 !text-red-600"
                          disabled={acting === r.id}
                        >
                          Rechazar
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {confirm && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 md:items-center" onClick={() => setConfirm(null)}>
          <div className="card w-full max-w-md space-y-4 !p-5" onClick={(e) => e.stopPropagation()}>
            {confirm.kind === "approve" ? (
              <>
                <h3 className="text-lg font-bold">¿Aprobar devolución?</h3>
                <p className="text-sm text-slate-600">
                  {confirm.req.technicians?.full_name} devuelve {formatQty(confirm.req.quantity)}{" "}
                  {confirm.req.materials?.unit} de {confirm.req.materials?.name}. Se registrará el
                  movimiento, se actualizará el stock (y las unidades pendientes si es reutilizable).
                  Queda registrado con tu usuario y la fecha actual.
                </p>
                <div className="flex justify-end gap-2">
                  <button onClick={() => setConfirm(null)} className="btn-secondary">
                    Cancelar
                  </button>
                  <button
                    onClick={() => approveConfirm(confirm.req)}
                    className="btn-primary !w-auto"
                    disabled={acting !== null}
                  >
                    {acting !== null ? "Procesando…" : "Confirmar aprobación"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 className="text-lg font-bold">¿Rechazar devolución?</h3>
                <p className="text-sm text-slate-600">
                  {confirm.req.technicians?.full_name} solicita devolver {formatQty(confirm.req.quantity)}{" "}
                  {confirm.req.materials?.unit} de {confirm.req.materials?.name}. El stock no será
                  modificado.
                </p>
                <textarea
                  className="input min-h-24 resize-none"
                  placeholder="Motivo del rechazo (se muestra en el historial)…"
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  autoFocus
                />
                <div className="flex justify-end gap-2">
                  <button onClick={() => setConfirm(null)} className="btn-secondary">
                    Cancelar
                  </button>
                  <button
                    onClick={() => rejectConfirm(confirm.req)}
                    className="btn-primary !w-auto"
                    disabled={acting !== null}
                  >
                    {acting !== null ? "Procesando…" : "Confirmar rechazo"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
