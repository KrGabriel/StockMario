import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import type { Technician } from "../../lib/types";
import { errorMessage } from "../../lib/format";

interface EditState {
  id: string | null;
  full_name: string;
  active: boolean;
}

export default function Technicians() {
  const [rows, setRows] = useState<Technician[]>([]);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    try {
      const res = await supabase.from("technicians").select("*").order("full_name");
      if (res.error) throw res.error;
      setRows((res.data ?? []) as Technician[]);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function save() {
    if (!editing) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const fullName = editing.full_name.trim();
      if (fullName.length < 2) throw new Error("El nombre debe tener al menos 2 caracteres.");
      const res = editing.id
        ? await supabase.from("technicians").update({ full_name: fullName, active: editing.active }).eq("id", editing.id)
        : await supabase.from("technicians").insert({ full_name: fullName, active: editing.active });
      if (res.error) throw res.error;
      setNotice(editing.id ? "Técnico actualizado." : "Técnico agregado.");
      setEditing(null);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(t: Technician) {
    setBusy(true);
    try {
      const res = await supabase
        .from("technicians")
        .update({ active: !t.active })
        .eq("id", t.id);
      if (res.error) throw res.error;
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="card">
        <button
          onClick={() => setEditing({ id: null, full_name: "", active: true })}
          className="btn-primary !w-auto"
        >
          + Nuevo técnico
        </button>
        <p className="mt-2 text-xs text-slate-500">
          Los técnicos inactivos no aparecen en el formulario móvil. Las referencias históricas se conservan.
        </p>
      </div>

      {notice && (
        <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{notice}</div>
      )}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      <div className="card overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200">
          <thead>
            <tr>
              <th className="th">Nombre</th>
              <th className="th">Estado</th>
              <th className="th">Alta</th>
              <th className="th">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((t) => (
              <tr key={t.id} className={t.active ? "" : "opacity-50"}>
                <td className="td font-medium">{t.full_name}</td>
                <td className="td">
                  {t.active ? (
                    <span className="badge bg-green-100 text-green-700">Activo</span>
                  ) : (
                    <span className="badge bg-slate-200 text-slate-600">Inactivo</span>
                  )}
                </td>
                <td className="td">{new Date(t.created_at).toLocaleDateString("es-AR")}</td>
                <td className="td">
                  <div className="flex gap-2">
                    <button
                      onClick={() => setEditing({ id: t.id, full_name: t.full_name, active: t.active })}
                      className="btn-secondary !px-2 !py-1"
                    >
                      Editar
                    </button>
                    <button onClick={() => toggleActive(t)} className="btn-secondary !px-2 !py-1">
                      {t.active ? "Desactivar" : "Activar"}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 md:items-center">
          <div className="card w-full max-w-sm space-y-4 !p-5">
            <h2 className="text-lg font-bold">{editing.id ? "Editar técnico" : "Nuevo técnico"}</h2>
            <div>
              <label className="label">Nombre completo</label>
              <input
                className="input"
                value={editing.full_name}
                onChange={(e) => setEditing({ ...editing, full_name: e.target.value })}
                autoFocus
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={editing.active}
                onChange={(e) => setEditing({ ...editing, active: e.target.checked })}
                className="h-4 w-4"
              />
              Activo (visible en el formulario móvil)
            </label>
            <div className="flex justify-end gap-2">
              <button onClick={() => setEditing(null)} className="btn-secondary">Cancelar</button>
              <button onClick={save} className="btn-primary !w-auto" disabled={busy}>
                {busy ? "Guardando…" : "Guardar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
