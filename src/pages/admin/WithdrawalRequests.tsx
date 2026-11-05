import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabase";
import type { MaterialStock, WithdrawalRequest } from "../../lib/types";
import { formatDateTime, formatQty, errorMessage } from "../../lib/format";
import PhotoPreview from "./PhotoPreview";

type Action =
  | { kind: "approve"; req: WithdrawalRequest }
  | { kind: "reject"; req: WithdrawalRequest }
  | { kind: "correct"; req: WithdrawalRequest }
  | { kind: "photo"; req: WithdrawalRequest }
  | null;

function notifyAdminBadge() {
  window.dispatchEvent(new CustomEvent("withdrawal-requests-updated"));
}

export default function WithdrawalRequests() {
  const [requests, setRequests] = useState<WithdrawalRequest[]>([]);
  const [materials, setMaterials] = useState<MaterialStock[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [acting, setActing] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Action>(null);
  const [adminNotes, setAdminNotes] = useState("");

  // Formulario de corrección (material real + cantidad real)
  const [corrQuery, setCorrQuery] = useState("");
  const [corrMaterial, setCorrMaterial] = useState<MaterialStock | null>(null);
  const [corrQuantity, setCorrQuantity] = useState("");
  const [corrError, setCorrError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await supabase
        .from("withdrawal_requests")
        .select(
          "id, technician_id, material_id, quantity, notes, photo_path, status, resolution_reason, corrected_material_id, corrected_quantity, admin_notes, requested_at, resolved_by, resolved_at, movement_id, idempotency_key, technicians ( full_name ), materials!withdrawal_requests_material_id_fkey ( name, code, unit ), corrected_material:withdrawal_requests_corrected_material_id_fkey ( name, code, unit ), profiles ( email )",
        )
        .eq("status", "pending")
        .order("requested_at", { ascending: true });
      if (res.error) throw res.error;
      setRequests((res.data ?? []) as unknown as WithdrawalRequest[]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Catálogo para el selector del caso "se retiró otro material"
    (async () => {
      const { data, error: mError } = await supabase
        .from("v_material_stock")
        .select("*")
        .eq("active", true)
        .order("name");
      if (!mError) setMaterials((data ?? []) as MaterialStock[]);
    })();
  }, [load]);

  const corrResults = useMemo(() => {
    const q = corrQuery.trim().toLowerCase();
    if (!q) return [];
    return materials
      .filter((m) => `${m.name} ${m.code} ${m.category ?? ""}`.toLowerCase().includes(q))
      .slice(0, 8);
  }, [corrQuery, materials]);

  const corrQty = Number(corrQuantity.replace(",", "."));

  const corrValidationError = useMemo(() => {
    if (!corrMaterial) return "Seleccioná el material realmente retirado.";
    if (!corrQty || corrQty <= 0) return "Ingresá la cantidad real retirada (mayor que cero).";
    return "";
  }, [corrMaterial, corrQty]);

  function openCorrect(req: WithdrawalRequest) {
    setConfirm({ kind: "correct", req });
    setCorrQuery("");
    setCorrMaterial(null);
    setCorrQuantity("");
    setAdminNotes("");
    setCorrError("");
  }

  function closeConfirm() {
    setConfirm(null);
    setAdminNotes("");
  }

  async function approveConfirm(req: WithdrawalRequest) {
    setActing(req.id);
    setError("");
    setNotice("");
    try {
      const { error: rpcError } = await supabase.rpc("approve_withdrawal_request", {
        p_request_id: req.id,
      });
      if (rpcError) throw rpcError;
      setNotice(
        `Retiro aprobado: ${formatQty(req.quantity)} ${req.materials?.unit ?? "un"} de ${
          req.materials?.name ?? ""
        } de ${req.technicians?.full_name ?? ""}. Stock actualizado.`,
      );
      setConfirm(null);
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

  async function rejectConfirm(req: WithdrawalRequest) {
    setActing(req.id);
    setError("");
    setNotice("");
    try {
      const { error: rpcError } = await supabase.rpc("reject_withdrawal_request", {
        p_request_id: req.id,
        p_admin_notes: adminNotes.trim() ? adminNotes.trim() : null,
      });
      if (rpcError) throw rpcError;
      setNotice(`Solicitud rechazada: no se retiró nada. El stock no fue modificado.`);
      setConfirm(null);
      setAdminNotes("");
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

  async function correctConfirm(req: WithdrawalRequest) {
    if (corrValidationError) {
      setCorrError(corrValidationError);
      return;
    }
    setActing(req.id);
    setError("");
    setNotice("");
    try {
      const { error: rpcError } = await supabase.rpc("correct_withdrawal_request", {
        p_request_id: req.id,
        p_corrected_material_id: corrMaterial!.id,
        p_corrected_quantity: corrQty,
        p_admin_notes: adminNotes.trim() ? adminNotes.trim() : null,
      });
      if (rpcError) throw rpcError;
      setNotice(
        `Retiro corregido: se registró ${formatQty(corrQty)} ${corrMaterial!.unit} de ${
          corrMaterial!.name
        } en lugar de lo declarado. Stock actualizado solo con el material real.`,
      );
      setConfirm(null);
      setAdminNotes("");
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

  function photoDetails(req: WithdrawalRequest) {
    return [
      { label: "Técnico", value: req.technicians?.full_name ?? "-" },
      { label: "Material declarado", value: req.materials?.name ?? "-" },
      {
        label: "Cantidad declarada",
        value: `${formatQty(req.quantity)} ${req.materials?.unit ?? ""}`,
      },
      { label: "Observaciones", value: req.notes ?? "-" },
    ];
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
        <h2 className="font-semibold text-slate-900">Retiros pendientes de aprobación ({requests.length})</h2>
        <p className="mt-1 text-sm text-slate-500">
          Las solicitudes pendientes no afectan el stock: el retiro se descuenta solo al aprobar o al
          confirmar la corrección.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-slate-500">Cargando…</p>
      ) : (
        <div className="card overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead>
              <tr>
                <th className="th">Solicitado</th>
                <th className="th">Técnico</th>
                <th className="th">Material</th>
                <th className="th text-right">Cantidad</th>
                <th className="th text-center">Foto</th>
                <th className="th">Observaciones</th>
                <th className="th text-center">Estado</th>
                <th className="th">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {requests.length === 0 ? (
                <tr>
                  <td className="td" colSpan={8}>
                    No hay retiros pendientes de aprobación.
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
                    <td className="td text-center">
                      <button
                        onClick={() => setConfirm({ kind: "photo", req: r })}
                        className="text-violet-600 underline hover:text-violet-800"
                        title="Ver fotografía ampliada junto a los datos declarados"
                      >
                        📷 Ver
                      </button>
                    </td>
                    <td className="td max-w-40 truncate" title={r.notes ?? ""}>
                      {r.notes ?? "-"}
                    </td>
                    <td className="td text-center">
                      <span className="badge bg-amber-100 text-amber-700">Pendiente</span>
                    </td>
                    <td className="td">
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => setConfirm({ kind: "approve", req: r })}
                          className="btn-secondary !px-2 !py-1 !border-green-300 !text-green-700"
                          disabled={acting === r.id}
                        >
                          Aprobar retiro
                        </button>
                        <button
                          onClick={() => {
                            setConfirm({ kind: "reject", req: r });
                            setAdminNotes("");
                          }}
                          className="btn-secondary !px-2 !py-1 !border-red-200 !text-red-600"
                          disabled={acting === r.id}
                        >
                          No se retiró nada
                        </button>
                        <button
                          onClick={() => openCorrect(r)}
                          className="btn-secondary !px-2 !py-1 !border-amber-300 !text-amber-700"
                          disabled={acting === r.id}
                        >
                          Se retiró otro material
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

      {confirm?.kind === "photo" && (
        <PhotoPreview
          photoPath={confirm.req.photo_path}
          createdAt={confirm.req.requested_at}
          title={`Foto del retiro · ${confirm.req.technicians?.full_name ?? "-"}`}
          subtitle="Datos declarados por el técnico"
          details={photoDetails(confirm.req)}
          onClose={closeConfirm}
        />
      )}

      {confirm && confirm.kind !== "photo" && (
        <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-black/40 p-4 md:items-center" onClick={closeConfirm}>
          <div className="card w-full max-w-md space-y-4 !p-5" onClick={(e) => e.stopPropagation()}>
            {confirm.kind === "approve" && (
              <>
                <h3 className="text-lg font-bold">¿Aprobar el retiro tal como fue registrado?</h3>
                <div className="rounded-xl bg-slate-50 p-3 text-sm">
                  <p className="text-slate-700">
                    <span className="font-semibold">{confirm.req.technicians?.full_name}</span> declaró
                    retirar {formatQty(confirm.req.quantity)} {confirm.req.materials?.unit} de{" "}
                    <span className="font-semibold">{confirm.req.materials?.name}</span>.
                  </p>
                  <p className="mt-2 text-xs text-slate-500">
                    Verificá que la fotografía coincida antes de confirmar. Se registrará el
                    movimiento, se descontará el stock y quedará registrado con tu usuario y la fecha
                    actual.
                  </p>
                </div>
                <div className="flex justify-end gap-2">
                  <button onClick={closeConfirm} className="btn-secondary">
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
            )}

            {confirm.kind === "reject" && (
              <>
                <h3 className="text-lg font-bold">¿Rechazar porque no se retiró nada?</h3>
                <p className="text-sm text-slate-600">
                  {confirm.req.technicians?.full_name} declaró{" "}
                  {formatQty(confirm.req.quantity)} {confirm.req.materials?.unit} de{" "}
                  {confirm.req.materials?.name}. El stock no será modificado y no contará como retiro
                  efectivo. La solicitud queda disponible en el historial.
                </p>
                <textarea
                  className="input min-h-24 resize-none"
                  placeholder="Observación administrativa (opcional)…"
                  value={adminNotes}
                  onChange={(e) => setAdminNotes(e.target.value)}
                />
                <div className="flex justify-end gap-2">
                  <button onClick={closeConfirm} className="btn-secondary">
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

            {confirm.kind === "correct" && (
              <>
                <h3 className="text-lg font-bold">¿Se retiró otro material?</h3>
                <p className="text-sm text-slate-600">
                  El técnico declaró {formatQty(confirm.req.quantity)} {confirm.req.materials?.unit} de{" "}
                  <span className="font-semibold">{confirm.req.materials?.name}</span>. Indicá el
                  material realmente retirado; los datos originales no se modifican y el stock se
                  descuenta únicamente de lo que confirmes acá.
                </p>

                <div className="relative">
                  <label htmlFor="corr-material" className="label">
                    Material realmente retirado
                  </label>
                  <input
                    id="corr-material"
                    className="input"
                    placeholder="Buscá por nombre, código o categoría…"
                    value={corrMaterial ? corrMaterial.name : corrQuery}
                    onChange={(e) => {
                      setCorrQuery(e.target.value);
                      setCorrMaterial(null);
                    }}
                    autoComplete="off"
                  />
                  {corrMaterial && (
                    <button
                      type="button"
                      onClick={() => {
                        setCorrMaterial(null);
                        setCorrQuery("");
                      }}
                      className="absolute right-3 top-10 text-slate-400 hover:text-slate-600"
                      aria-label="Quitar selección"
                    >
                      ✕
                    </button>
                  )}
                  {!corrMaterial && corrResults.length > 0 && (
                    <ul className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-xl border border-slate-200 bg-white shadow-lg">
                      {corrResults.map((m) => (
                        <li key={m.id}>
                          <button
                            type="button"
                            className="w-full px-4 py-2.5 text-left hover:bg-slate-50"
                            onClick={() => {
                              setCorrMaterial(m);
                              setCorrQuery(m.name);
                            }}
                          >
                            <span className="block font-medium text-slate-900">{m.name}</span>
                            <span className="text-xs text-slate-500">
                              {m.code} · Stock: {formatQty(m.current_stock)} {m.unit}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {corrMaterial && (
                    <p className="mt-1 text-xs text-slate-500">
                      <span className="badge bg-sky-100 text-sky-700">
                        {corrMaterial.material_type === "reusable" ? "Reutilizable" : "Consumible"}
                      </span>{" "}
                      Unidad: <span className="font-medium">{corrMaterial.unit}</span>
                    </p>
                  )}
                </div>

                <div>
                  <label htmlFor="corr-qty" className="label">
                    Cantidad realmente retirada ({corrMaterial?.unit ?? "un"})
                  </label>
                  <input
                    id="corr-qty"
                    className="input"
                    inputMode="decimal"
                    placeholder="Ej: 50"
                    value={corrQuantity}
                    onChange={(e) => setCorrQuantity(e.target.value.replace(/[^\d.,]/g, ""))}
                  />
                  {corrMaterial && corrQty > 0 && corrQty > corrMaterial.current_stock && (
                    <p className="mt-1 text-xs text-red-600">
                      Stock insuficiente: hay {formatQty(corrMaterial.current_stock)}{" "}
                      {corrMaterial.unit}. No se podrá aprobar hasta que exista stock suficiente.
                    </p>
                  )}
                </div>

                <textarea
                  className="input min-h-20 resize-none"
                  placeholder="Observaciones administrativas (opcional)…"
                  value={adminNotes}
                  onChange={(e) => setAdminNotes(e.target.value)}
                />

                {(corrError || corrValidationError) && (
                  <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                    {corrValidationError || corrError}
                  </p>
                )}

                <div className="flex justify-end gap-2">
                  <button onClick={closeConfirm} className="btn-secondary">
                    Cancelar
                  </button>
                  <button
                    onClick={() => correctConfirm(confirm.req)}
                    className="btn-primary !w-auto"
                    disabled={acting !== null}
                  >
                    {acting !== null ? "Procesando…" : "Confirmar corrección"}
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
