import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import type { MaterialStock, Technician, AllocationInput } from "../lib/types";
import {
  formatQty,
  formatDateTime,
  errorMessage,
  randomIdempotencyKey,
} from "../lib/format";

type Phase = "form" | "submitting" | "success";

export default function MovementForm() {
  const [technicians, setTechnicians] = useState<Technician[]>([]);
  const [materials, setMaterials] = useState<MaterialStock[]>([]);
  const [loadingLists, setLoadingLists] = useState(true);

  const [technicianId, setTechnicianId] = useState("");
  const [movementType, setMovementType] = useState<"withdrawal" | "return">("withdrawal");
  const [materialQuery, setMaterialQuery] = useState("");
  const [showResults, setShowResults] = useState(false);
  const [selectedMaterial, setSelectedMaterial] = useState<MaterialStock | null>(null);
  const [quantity, setQuantity] = useState("");
  const [notes, setNotes] = useState("");

  const [pending, setPending] = useState<
    { id: string; withdrawn_at: string; pending_qty: number }[]
  >([]);
  const [manualAlloc, setManualAlloc] = useState(false);
  const [allocQty, setAllocQty] = useState<Record<string, string>>({});

  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  const keyRef = useRef<string>("");

  useEffect(() => {
    document.title = "Registro de movimientos · Depósito SwissNet";
    (async () => {
      try {
        const [techRes, matRes] = await Promise.all([
          supabase
            .from("technicians")
            .select("id, full_name")
            .eq("active", true)
            .order("full_name"),
          supabase
            .from("v_material_stock")
            .select("*")
            .eq("active", true)
            .order("name"),
        ]);
        if (techRes.error) throw techRes.error;
        if (matRes.error) throw matRes.error;
        setTechnicians(techRes.data as Technician[]);
        setMaterials(matRes.data as MaterialStock[]);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoadingLists(false);
      }
    })();
  }, []);

  const results = useMemo(() => {
    const q = materialQuery.trim().toLowerCase();
    if (!q) return [];
    return materials
      .filter((m) =>
        `${m.name} ${m.code} ${m.category ?? ""}`.toLowerCase().includes(q),
      )
      .slice(0, 12);
  }, [materialQuery, materials]);

  useEffect(() => {
    const isReturn = movementType === "return";
    const isReusable = selectedMaterial?.material_type === "reusable";
    if (isReturn && isReusable && technicianId && selectedMaterial) {
      loadPending(technicianId, selectedMaterial.id);
    } else {
      setPending([]);
      setAllocQty({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movementType, selectedMaterial?.id, technicianId]);

  async function loadPending(techId: string, materialId: string) {
    try {
      const { data, error } = await supabase.rpc("get_pending_withdrawals", {
        p_technician_id: techId,
        p_material_id: materialId,
      });
      if (error) throw error;
      setPending(data ?? []);
      setAllocQty({});
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  function selectMaterial(m: MaterialStock) {
    setSelectedMaterial(m);
    setMaterialQuery(m.name);
    setShowResults(false);
    setQuantity("");
  }

  function clearMaterial() {
    setSelectedMaterial(null);
    setMaterialQuery("");
    setQuantity("");
    setPending([]);
    setAllocQty({});
  }

  function resetForm(full: boolean) {
    if (full) setTechnicianId("");
    setMovementType("withdrawal");
    clearMaterial();
    setNotes("");
    setManualAlloc(false);
    setError("");
    setPhase("form");
  }

  const qtyNum = Number(quantity.replace(",", "."));
  const allocations = manualAlloc
    ? pending
        .map((p) => ({
          withdrawal_movement_id: p.id,
          quantity: Number((allocQty[p.id] ?? "").replace(",", ".")),
        }))
        .filter((a) => a.quantity > 0)
    : [];
  const allocSum = allocations.reduce((s, a) => s + a.quantity, 0);

  const validationError = useMemo(() => {
    if (!technicianId) return "Seleccioná el técnico responsable.";
    if (!selectedMaterial) return "Buscá y seleccioná un material.";
    if (!qtyNum || qtyNum <= 0) return "Ingresá una cantidad mayor que cero.";
    if (movementType === "withdrawal" && qtyNum > (selectedMaterial.current_stock ?? 0))
      return `Stock insuficiente: hay ${formatQty(selectedMaterial.current_stock)} ${selectedMaterial.unit}.`;
    if (movementType === "return" && selectedMaterial.material_type === "reusable") {
      if (allocations.length > 0 && Math.abs(allocSum - qtyNum) > 0.0001) {
        return `Las asignaciones (${formatQty(allocSum)}) deben sumar exactamente la cantidad devuelta (${formatQty(qtyNum)}).`;
      }
      if (allocations.length === 0 && pending.every((p) => Number(allocQty[p.id] || 0) === 0) && !manualAlloc) {
        // FIFO automático, permitido
      }
      const totalPending = pending.reduce((s, p) => s + p.pending_qty, 0);
      if (qtyNum > totalPending) {
        return `No podés devolver más que el pendiente (${formatQty(totalPending)}).`;
      }
      for (const p of pending) {
        const a = Number((allocQty[p.id] ?? "").replace(",", ".")) || 0;
        if (a > p.pending_qty) {
          return `Una asignación supera el pendiente del retiro (${formatQty(p.pending_qty)}).`;
        }
      }
    }
    return "";
  }, [
    technicianId,
    selectedMaterial,
    qtyNum,
    movementType,
    allocations,
    allocSum,
    pending,
    allocQty,
    manualAlloc,
  ]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (validationError || phase === "submitting") return;

    keyRef.current = randomIdempotencyKey();
    setPhase("submitting");
    setError("");

    try {
      const isWithdrawal = movementType === "withdrawal";
      const rpcName = isWithdrawal ? "create_withdrawal" : "create_return";
      const args: Record<string, unknown> = {
        p_technician_id: technicianId,
        p_material_id: selectedMaterial!.id,
        p_quantity: qtyNum,
        p_notes: notes.trim() ? notes.trim() : null,
        p_idempotency_key: keyRef.current,
      };
      if (
        !isWithdrawal &&
        selectedMaterial!.material_type === "reusable" &&
        allocations.length > 0
      ) {
        args.p_allocations = allocations as AllocationInput[];
      }

      const { error: rpcError } = await supabase.rpc(rpcName, args);
      if (rpcError) throw rpcError;

      setSuccessMsg(
        isWithdrawal
          ? `Retiro registrado: ${formatQty(qtyNum)} ${selectedMaterial!.unit} de ${selectedMaterial!.name}`
          : `Devolución registrada: ${formatQty(qtyNum)} ${selectedMaterial!.unit} de ${selectedMaterial!.name}`,
      );
      setPhase("success");
    } catch (e) {
      setError(errorMessage(e));
      setPhase("form");
    }
  }

  if (phase === "success") {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center p-4">
        <div className="card text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
            <svg
              className="h-8 w-8 text-green-600"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-slate-900">Movimiento registrado</h1>
          <p className="mt-2 text-slate-600">{successMsg}</p>
          <button onClick={() => resetForm(false)} className="btn-primary mt-6">
            Registrar otro movimiento
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-screen max-w-lg p-4 pb-24">
      <header className="mb-4 flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-brand-600">
            Depósito SwissNet
          </p>
          <h1 className="text-xl font-bold text-slate-900">Registro de movimientos</h1>
        </div>
        <Link to="/admin" className="text-sm font-medium text-slate-500 underline">
          Admin
        </Link>
      </header>

      {error && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="card space-y-4">
          <div>
            <label htmlFor="technician" className="label">
              Técnico responsable
            </label>
            <select
              id="technician"
              className="input"
              value={technicianId}
              onChange={(e) => setTechnicianId(e.target.value)}
              disabled={loadingLists}
            >
              <option value="">
                {loadingLists ? "Cargando…" : "Seleccioná tu nombre…"}
              </option>
              {technicians.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.full_name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <span className="label">Tipo de movimiento</span>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setMovementType("withdrawal")}
                className={`rounded-xl border-2 px-4 py-3 text-base font-bold transition ${
                  movementType === "withdrawal"
                    ? "border-brand-600 bg-brand-50 text-brand-700"
                    : "border-slate-200 bg-white text-slate-500"
                }`}
              >
                Retiro
              </button>
              <button
                type="button"
                onClick={() => setMovementType("return")}
                className={`rounded-xl border-2 px-4 py-3 text-base font-bold transition ${
                  movementType === "return"
                    ? "border-green-600 bg-green-50 text-green-700"
                    : "border-slate-200 bg-white text-slate-500"
                }`}
              >
                Devolución
              </button>
            </div>
          </div>
        </div>

        <div className="card space-y-4">
          <div className="relative">
            <label htmlFor="material" className="label">
              Material / herramienta
            </label>
            <input
              id="material"
              className="input"
              placeholder="Buscá por nombre, código o categoría…"
              value={materialQuery}
              onChange={(e) => {
                setMaterialQuery(e.target.value);
                setShowResults(true);
                if (selectedMaterial && e.target.value !== selectedMaterial.name) {
                  setSelectedMaterial(null);
                }
              }}
              onFocus={() => setShowResults(true)}
              autoComplete="off"
            />
            {selectedMaterial && (
              <button
                type="button"
                onClick={clearMaterial}
                className="absolute right-3 top-10 text-slate-400 hover:text-slate-600"
                aria-label="Quitar selección"
              >
                ✕
              </button>
            )}
            {showResults && !selectedMaterial && results.length > 0 && (
              <ul className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-xl border border-slate-200 bg-white shadow-lg">
                {results.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      className="w-full px-4 py-3 text-left hover:bg-slate-50"
                      onClick={() => selectMaterial(m)}
                    >
                      <span className="block font-medium text-slate-900">{m.name}</span>
                      <span className="text-xs text-slate-500">
                        {m.code}
                        {m.category ? ` · ${m.category}` : ""} · Stock:{" "}
                        <span
                          className={
                            m.current_stock <= 0
                              ? "text-red-600 font-semibold"
                              : m.is_low_stock
                                ? "text-amber-600 font-semibold"
                                : "text-green-600 font-semibold"
                          }
                        >
                          {formatQty(m.current_stock)} {m.unit}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {showResults && !selectedMaterial && results.length === 0 && materialQuery.trim() && (
              <p className="absolute z-20 mt-1 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500 shadow-lg">
                Sin resultados para “{materialQuery}”.
              </p>
            )}
          </div>

          {selectedMaterial && (
            <div className="rounded-xl bg-slate-50 p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-slate-800">{selectedMaterial.name}</span>
                <span
                  className={`badge ${
                    selectedMaterial.material_type === "reusable"
                      ? "bg-violet-100 text-violet-700"
                      : "bg-sky-100 text-sky-700"
                  }`}
                >
                  {selectedMaterial.material_type === "reusable" ? "Reutilizable" : "Consumible"}
                </span>
              </div>
              <p className="mt-1 text-slate-500">
                {selectedMaterial.code}
                {selectedMaterial.category ? ` · ${selectedMaterial.category}` : ""}
              </p>
              <p className="mt-1 font-medium text-slate-700">
                Stock disponible: {formatQty(selectedMaterial.current_stock)}{" "}
                {selectedMaterial.unit}
                {selectedMaterial.is_low_stock && selectedMaterial.current_stock > 0 && (
                  <span className="ml-2 badge bg-amber-100 text-amber-700">Stock bajo</span>
                )}
                {selectedMaterial.current_stock <= 0 && (
                  <span className="ml-2 badge bg-red-100 text-red-700">Sin stock</span>
                )}
              </p>
            </div>
          )}

          <div>
            <label htmlFor="qty" className="label">
              Cantidad ({selectedMaterial?.unit ?? "un"})
            </label>
            <input
              id="qty"
              className="input"
              inputMode="decimal"
              placeholder="Ej: 2"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value.replace(/[^\d.,]/g, ""))}
            />
          </div>

          {movementType === "return" &&
            selectedMaterial?.material_type === "reusable" &&
            pending.length > 0 && (
              <div className="rounded-xl border border-violet-200 bg-violet-50 p-3">
                <p className="text-sm font-semibold text-violet-800">
                  Retiros pendientes de devolución por vos
                </p>
                <label className="mt-2 flex items-center gap-2 text-sm text-violet-700">
                  <input
                    type="checkbox"
                    checked={manualAlloc}
                    onChange={(e) => setManualAlloc(e.target.checked)}
                    className="h-4 w-4"
                  />
                  Asignar manualmente a retiros (si no, se asigna automático del más antiguo)
                </label>
                {manualAlloc && (
                  <ul className="mt-3 space-y-2">
                    {pending.map((p) => (
                      <li key={p.id} className="flex items-center gap-2 text-sm">
                        <span className="flex-1 text-slate-700">
                          {formatDateTime(p.withdrawn_at)}{" "}
                          <span className="text-slate-400">
                            (pendiente {formatQty(p.pending_qty)})
                          </span>
                        </span>
                        <input
                          className="w-20 rounded-lg border border-slate-300 px-2 py-1.5 text-right"
                          inputMode="decimal"
                          placeholder="0"
                          value={allocQty[p.id] ?? ""}
                          onChange={(e) =>
                            setAllocQty({ ...allocQty, [p.id]: e.target.value.replace(/[^\d.,]/g, "") })
                          }
                        />
                      </li>
                    ))}
                    <li className="text-xs text-violet-600">
                      Asignado: {formatQty(allocSum)} / devolvés: {formatQty(qtyNum || 0)}
                    </li>
                  </ul>
                )}
              </div>
            )}

          <div>
            <label htmlFor="notes" className="label">
              Observaciones (opcional)
            </label>
            <textarea
              id="notes"
              className="input min-h-20 resize-none"
              placeholder="Ej: para instalación en Av. Siempre Viva 742"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>

        {validationError && (
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {validationError}
          </p>
        )}

        <button type="submit" className="btn-primary" disabled={!!validationError || phase === "submitting"}>
          {phase === "submitting" ? "Registrando…" : "Confirmar movimiento"}
        </button>
      </form>
    </main>
  );
}
