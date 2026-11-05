import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import type { Category, MaterialStock, MaterialType } from "../../lib/types";
import { formatQty, errorMessage } from "../../lib/format";
import { toCsv } from "../../lib/csv";

interface EditState {
  id: string | null;
  code: string;
  name: string;
  category: string;
  material_type: MaterialType;
  unit: string;
  initial_stock: string;
  minimum_stock: string;
  active: boolean;
}

const EMPTY: EditState = {
  id: null,
  code: "",
  name: "",
  category: "",
  material_type: "consumable",
  unit: "un",
  initial_stock: "0",
  minimum_stock: "0",
  active: true,
};

export default function Materials() {
  const [rows, setRows] = useState<MaterialStock[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [editing, setEditing] = useState<EditState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function load() {
    try {
      const res = await supabase
        .from("v_material_stock")
        .select("*")
        .order("name");
      if (res.error) throw res.error;
      setRows((res.data ?? []) as MaterialStock[]);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function loadCategories() {
    try {
      const res = await supabase.from("categories").select("id, name, created_at").order("name");
      if (res.error) throw res.error;
      setCategories((res.data ?? []) as Category[]);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  useEffect(() => {
    load();
    loadCategories();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((m) => {
      if (typeFilter && m.material_type !== typeFilter) return false;
      if (!q) return true;
      return `${m.name} ${m.code} ${m.category ?? ""}`.toLowerCase().includes(q);
    });
  }, [rows, query, typeFilter]);

  function openEdit(m: MaterialStock) {
    setEditing({
      id: m.id,
      code: m.code,
      name: m.name,
      category: m.category ?? "",
      material_type: m.material_type,
      unit: m.unit,
      initial_stock: String(m.initial_stock),
      minimum_stock: String(m.minimum_stock),
      active: m.active,
    });
    // Refresca el catálogo por si hubo cambios desde la sección de categorías
    loadCategories();
  }

  function openNew() {
    setEditing({ ...EMPTY });
    loadCategories();
  }

  // Lista desplegable: si el material editado tiene una categoría que ya no
  // esté en el catálogo, se agrega a la lista para no perder el dato.
  const categoryOptions = useMemo(() => {
    const opts = [...categories];
    const editingCat = editing?.category?.trim();
    if (editingCat && !opts.some((c) => c.name === editingCat)) {
      opts.push({ id: "editing-current", name: editingCat, created_at: "" });
    }
    return opts;
  }, [categories, editing]);

  async function save() {
    if (!editing) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const payload = {
        code: editing.code.trim(),
        name: editing.name.trim(),
        category: editing.category.trim() || null,
        material_type: editing.material_type,
        unit: editing.unit.trim() || "un",
        initial_stock: Number(editing.initial_stock.replace(",", ".")) || 0,
        minimum_stock: Number(editing.minimum_stock.replace(",", ".")) || 0,
        active: editing.active,
      };
      if (!payload.code || !payload.name) {
        throw new Error("El código y el nombre son obligatorios.");
      }
      let res;
      if (editing.id) {
        res = await supabase.from("materials").update(payload).eq("id", editing.id);
      } else {
        res = await supabase.from("materials").insert(payload);
      }
      if (res.error) throw res.error;
      setNotice(editing.id ? "Material actualizado." : "Material creado.");
      setEditing(null);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(m: MaterialStock) {
    setBusy(true);
    try {
      const res = await supabase
        .from("materials")
        .update({ active: !m.active })
        .eq("id", m.id);
      if (res.error) throw res.error;
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function importCsv(file: File) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const text = await file.text();
      const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
      if (lines.length < 2) throw new Error("El CSV debe tener encabezado y al menos una fila.");
      const header = lines[0].split(/[;,\t]/).map((h) => h.trim().toLowerCase());
      const idx = (name: string) => header.indexOf(name);
      const need = ["codigo", "nombre"];
      if (!header.includes(need[0]) && !header.includes("code")) {
        throw new Error("Falta la columna 'codigo' (o 'code') en el encabezado.");
      }
      if (!header.includes(need[1]) && !header.includes("name")) {
        throw new Error("Falta la columna 'nombre' (o 'name') en el encabezado.");
      }
      const codeIdx = idx("codigo") >= 0 ? idx("codigo") : idx("code");
      const nameIdx = idx("nombre") >= 0 ? idx("nombre") : idx("name");
      const catIdx = idx("categoria");
      const typeIdx = idx("tipo");
      const unitIdx = idx("unidad");
      const stockIdx = idx("stock");
      const minIdx = idx("minimo");

      const parsed = lines.slice(1).map((line) => {
        const cells = line.split(/[;,\t]/).map((c) => c.trim());
        const tipo = (cells[typeIdx] ?? "").toLowerCase();
        let material_type: MaterialType = "consumable";
        if (tipo.startsWith("h") || tipo.startsWith("r") || tipo === "reusable" || tipo === "herramienta") {
          material_type = "reusable";
        }
        return {
          code: cells[codeIdx],
          name: cells[nameIdx],
          category: catIdx >= 0 ? cells[catIdx] : null,
          material_type: typeIdx >= 0 ? material_type : "consumable",
          unit: unitIdx >= 0 ? cells[unitIdx] : "un",
          initial_stock: stockIdx >= 0 ? Number(cells[stockIdx].replace(",", ".")) || 0 : 0,
          minimum_stock: minIdx >= 0 ? Number(cells[minIdx].replace(",", ".")) || 0 : 0,
        };
      });

      const { data, error: rpcError } = await supabase.rpc("import_materials", {
        p_rows: parsed,
      });
      if (rpcError) throw rpcError;
      setNotice(`Importación completada: ${data} filas procesadas.`);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function exportTemplate() {
    const csv = toCsv([
      ["codigo", "nombre", "categoria", "tipo", "unidad", "stock", "minimo"],
      ["UTP-001", "Cable UTP Cat 6", "Cables", "consumable", "m", "1000", "100"],
      ["HER-001", "Fusionadora", "Herramientas", "reusable", "un", "2", "0"],
    ]);
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "plantilla-inventario.csv";
    a.click();
  }

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex flex-wrap items-end gap-3">
          <button onClick={openNew} className="btn-primary !w-auto">+ Nuevo material</button>
          <button onClick={() => fileRef.current?.click()} className="btn-secondary" disabled={busy}>
            Importar inventario (CSV)
          </button>
          <button onClick={exportTemplate} className="btn-secondary">
            Descargar plantilla CSV
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && importCsv(e.target.files[0])}
          />
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Columnas del CSV: codigo, nombre, categoria, tipo (consumable/reusable o consumible/herramienta), unidad, stock, minimo.
        </p>
      </div>

      {notice && (
        <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{notice}</div>
      )}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      <div className="card !p-2">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3 !p-2">
          <input
            className="input md:col-span-2"
            placeholder="Buscar por nombre, código o categoría…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select className="input" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="">Todos los tipos</option>
            <option value="consumable">Consumibles</option>
            <option value="reusable">Reutilizables</option>
          </select>
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200">
          <thead>
            <tr>
              <th className="th">Material</th>
              <th className="th">Categoría</th>
              <th className="th">Tipo</th>
              <th className="th text-right">Inicial</th>
              <th className="th text-right">Retirado</th>
              <th className="th text-right">Devuelto</th>
              <th className="th text-right">Stock actual</th>
              <th className="th">Estado</th>
              <th className="th">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.length === 0 ? (
              <tr><td className="td" colSpan={9}>Sin materiales. Crealos o importá el inventario.</td></tr>
            ) : (
              filtered.map((m) => (
                <tr key={m.id} className={m.active ? "" : "opacity-50"}>
                  <td className="td">
                    <span className="font-medium">{m.name}</span>
                    <span className="block text-xs text-slate-400">{m.code} · {m.unit}</span>
                  </td>
                  <td className="td">{m.category ?? "-"}</td>
                  <td className="td">
                    <span className={`badge ${m.material_type === "reusable" ? "bg-violet-100 text-violet-700" : "bg-sky-100 text-sky-700"}`}>
                      {m.material_type === "reusable" ? "Reutilizable" : "Consumible"}
                    </span>
                  </td>
                  <td className="td text-right">{formatQty(m.initial_stock)}</td>
                  <td className="td text-right">{formatQty(m.total_withdrawn)}</td>
                  <td className="td text-right">{formatQty(m.total_returned)}</td>
                  <td
                    className={`td text-right font-bold ${
                      m.is_out_of_stock ? "text-red-600" : m.is_low_stock ? "text-amber-600" : "text-green-600"
                    }`}
                  >
                    {formatQty(m.current_stock)}
                  </td>
                  <td className="td">
                    {m.active ? (
                      <span className="badge bg-green-100 text-green-700">Activo</span>
                    ) : (
                      <span className="badge bg-slate-200 text-slate-600">Inactivo</span>
                    )}
                  </td>
                  <td className="td">
                    <div className="flex gap-2">
                      <button onClick={() => openEdit(m)} className="btn-secondary !px-2 !py-1">Editar</button>
                      <button onClick={() => toggleActive(m)} className="btn-secondary !px-2 !py-1">
                        {m.active ? "Desactivar" : "Activar"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 md:items-center">
          <div className="card w-full max-w-lg space-y-4 !p-5">
            <h2 className="text-lg font-bold">{editing.id ? "Editar material" : "Nuevo material"}</h2>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-1">
                <label className="label">Código</label>
                <input className="input" value={editing.code} onChange={(e) => setEditing({ ...editing, code: e.target.value })} />
              </div>
              <div className="col-span-1">
                <label className="label">Tipo</label>
                <select
                  className="input"
                  value={editing.material_type}
                  onChange={(e) => setEditing({ ...editing, material_type: e.target.value as MaterialType })}
                >
                  <option value="consumable">Consumible</option>
                  <option value="reusable">Reutilizable</option>
                </select>
              </div>
              <div className="col-span-2">
                <label className="label">Nombre</label>
                <input className="input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              </div>
              <div className="col-span-2">
                <div className="flex items-baseline justify-between">
                  <label className="label" htmlFor="mat-category">Categoría</label>
                  <Link to="/admin/categorias" className="text-xs text-brand-600 underline">
                    Gestionar categorías
                  </Link>
                </div>
                <select
                  id="mat-category"
                  className="input"
                  value={editing.category}
                  onChange={(e) => setEditing({ ...editing, category: e.target.value })}
                >
                  <option value="">— Sin categoría —</option>
                  {categoryOptions.map((c) => (
                    <option key={c.id} value={c.name}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Unidad</label>
                <input className="input" placeholder="un, m, kg…" value={editing.unit} onChange={(e) => setEditing({ ...editing, unit: e.target.value })} />
              </div>
              <div>
                <label className="label">Stock inicial</label>
                <input className="input" inputMode="decimal" value={editing.initial_stock} onChange={(e) => setEditing({ ...editing, initial_stock: e.target.value.replace(/[^\d.,]/g, "") })} />
              </div>
              <div>
                <label className="label">Stock mínimo</label>
                <input className="input" inputMode="decimal" value={editing.minimum_stock} onChange={(e) => setEditing({ ...editing, minimum_stock: e.target.value.replace(/[^\d.,]/g, "") })} />
              </div>
              <div className="flex items-end pb-2">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} className="h-4 w-4" />
                  Activo
                </label>
              </div>
            </div>
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
