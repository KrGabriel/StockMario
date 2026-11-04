import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import type { PendingWithdrawal } from "../../lib/types";
import { formatDateTime, formatQty, relativeTime, errorMessage } from "../../lib/format";

export default function Pending() {
  const [rows, setRows] = useState<PendingWithdrawal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const { data, error: qError } = await supabase
          .from("v_pending_withdrawals")
          .select("*")
          .order("withdrawn_at", { ascending: true });
        if (qError) throw qError;
        setRows((data ?? []) as PendingWithdrawal[]);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="card overflow-x-auto">
      <h2 className="mb-2 font-semibold text-slate-900">
        Herramientas y equipos fuera del depósito ({rows.reduce((s, r) => s + r.pending_qty, 0)} unidades)
      </h2>
      <p className="mb-4 text-sm text-slate-500">
        Ordenado por antigüedad: los primeros llevan más tiempo sin volver.
      </p>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {loading ? (
        <p className="text-sm text-slate-500">Cargando…</p>
      ) : (
        <table className="min-w-full divide-y divide-slate-200">
          <thead>
            <tr>
              <th className="th">Equipo / herramienta</th>
              <th className="th">Técnico</th>
              <th className="th">Retirado</th>
              <th className="th text-right">Cant.</th>
              <th className="th text-right">Devuelto</th>
              <th className="th text-right">Pendiente</th>
              <th className="th">Antigüedad</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 ? (
              <tr><td className="td" colSpan={7}>Todo volvió al depósito.</td></tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className={r.withdrawn_qty - r.returned_qty === r.withdrawn_qty ? "" : ""}>
                  <td className="td">
                    {r.material_name}
                    <span className="text-xs text-slate-400"> {r.material_code}</span>
                  </td>
                  <td className="td font-medium">{r.technician_name}</td>
                  <td className="td whitespace-nowrap">{formatDateTime(r.withdrawn_at)}</td>
                  <td className="td text-right">{formatQty(r.withdrawn_qty)}</td>
                  <td className="td text-right">{formatQty(r.returned_qty)}</td>
                  <td className="td text-right font-bold text-violet-700">{formatQty(r.pending_qty)}</td>
                  <td className="td whitespace-nowrap text-slate-500">{relativeTime(r.withdrawn_at)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
