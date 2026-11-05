import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabase";
import type { Category } from "../../lib/types";
import { formatDate, errorMessage } from "../../lib/format";

export default function Categories() {
  const [rows, setRows] = useState<Category[]>([]);
  const [usage, setUsage] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  const load = useCallback(async () => {
    try {
      const [catRes, matRes] = await Promise.all([
        supabase.from("categories").select("id, name, created_at").order("name"),
        supabase.from("materials").select("category"),
      ]);
      if (catRes.error) throw catRes.error;
      if (matRes.error) throw matRes.error;
      setRows((catRes.data ?? []) as Category[]);
      const counts = new Map<string, number>();
      for (const m of (matRes.data ?? []) as { category: string | null }[]) {
        const key = (m.category ?? "").trim();
        if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      setUsage(counts);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const emptyUsage = useMemo(
    () => rows.filter((c) => (usage.get(c.name) ?? 0) === 0).length,
    [rows, usage],
  );

  async function create() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const res = await supabase.from("categories").insert({ name });
      if (res.error) {
        if (res.error.code === "23505") {
          throw new Error(`Ya existe una categoría con el nombre "${name}".`);
        }
        throw res.error;
      }
      setNotice(`Categoría "${name}" creada.`);
      setNewName("");
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function rename(c: Category) {
    const name = editingName.trim();
    if (!name) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      // Propaga el nuevo nombre a los materiales que la usan (RPC transaccional)
      const { error: rpcError } = await supabase.rpc("rename_category", {
        p_category_id: c.id,
        p_new_name: name,
      });
      if (rpcError) throw rpcError;
      setNotice(`Categoría renombrada a "${name}". Los materiales se actualizaron automáticamente.`);
      setEditingId(null);
      setEditingName("");
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(c: Category) {
    if (!window.confirm(`¿Eliminar la categoría "${c.name}"?`)) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { error: rpcError } = await supabase.rpc("delete_category", {
        p_category_id: c.id,
      });
      if (rpcError) throw rpcError;
      setNotice(`Categoría "${c.name}" eliminada.`);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
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
        <h2 className="font-semibold text-slate-900">Gestión de categorías ({rows.length})</h2>
        <p className="mt-1 text-sm text-slate-500">
          Las categorías se usan en el alta y edición de materiales como lista desplegable. No se
          puede eliminar una categoría que tenga materiales asociados: reasignalos primero.
        </p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            className="input flex-1"
            placeholder="Nombre de la nueva categoría (ej: Herramientas)…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !busy && create()}
          />
          <button onClick={create} className="btn-primary !w-auto" disabled={busy || !newName.trim()}>
            + Crear categoría
          </button>
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200">
          <thead>
            <tr>
              <th className="th">Nombre</th>
              <th className="th text-right">Materiales asociados</th>
              <th className="th">Creada</th>
              <th className="th">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr><td className="td" colSpan={4}>Cargando…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td className="td" colSpan={4}>No hay categorías todavía. Creá la primera arriba.</td></tr>
            ) : (
              rows.map((c) => {
                const count = usage.get(c.name) ?? 0;
                const isEditing = editingId === c.id;
                return (
                  <tr key={c.id}>
                    <td className="td">
                      {isEditing ? (
                        <input
                          className="input"
                          value={editingName}
                          autoFocus
                          onChange={(e) => setEditingName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !busy) rename(c);
                            if (e.key === "Escape") setEditingId(null);
                          }}
                        />
                      ) : (
                        <span className="font-medium">{c.name}</span>
                      )}
                    </td>
                    <td className="td text-right">
                      <span className={count > 0 ? "font-medium text-slate-700" : "text-slate-400"}>
                        {count}
                      </span>
                    </td>
                    <td className="td whitespace-nowrap text-slate-500">{formatDate(c.created_at)}</td>
                    <td className="td">
                      <div className="flex flex-wrap gap-2">
                        {isEditing ? (
                          <>
                            <button onClick={() => rename(c)} className="btn-secondary !px-2 !py-1 !border-green-300 !text-green-700" disabled={busy}>
                              Guardar
                            </button>
                            <button onClick={() => { setEditingId(null); setEditingName(""); }} className="btn-secondary !px-2 !py-1" disabled={busy}>
                              Cancelar
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={() => { setEditingId(c.id); setEditingName(c.name); }}
                              className="btn-secondary !px-2 !py-1"
                              disabled={busy}
                            >
                              Renombrar
                            </button>
                            <button
                              onClick={() => remove(c)}
                              className="btn-secondary !px-2 !py-1 !border-red-200 !text-red-600"
                              disabled={busy}
                              title={count > 0 ? `Tiene ${count} material(es) asociados: reasignalos antes de eliminar` : "Eliminar categoría"}
                            >
                              Eliminar
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
        {rows.length > 0 && (
          <p className="mt-3 text-xs text-slate-500">
            {emptyUsage} categoría(s) sin materiales asociados pueden eliminarse libremente.
          </p>
        )}
      </div>
    </div>
  );
}
