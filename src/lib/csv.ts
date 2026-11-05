import type { Movement, Material, Technician } from "./types";
import { iclassOf } from "./types";
import { formatDateTime } from "./format";

function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\n;]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv(rows: unknown[][]): string {
  return rows
    .map((row) => row.map(csvEscape).join(";"))
    .join("\r\n");
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export interface HistoryJoin {
  movements: Movement[];
  technicians: Technician[];
  materials: Material[];
}

export function historyToCsv({
  movements,
  technicians,
  materials,
}: HistoryJoin): string {
  const tech = new Map(technicians.map((t) => [t.id, t.full_name]));
  const mat = new Map(materials.map((m) => [m.id, m]));
  const header = [
    "Fecha y hora",
    "Técnico",
    "Material",
    "Código",
    "Movimiento",
    "Cantidad",
    "Unidad",
    "Observaciones",
    "ICLASS",
    "Confirmado por",
    "Fecha confirmación ICLASS",
  ];
  const rows = movements.map((mv) => {
    const m = mat.get(mv.material_id);
    const conf = iclassOf(mv.iclass_confirmations);
    return [
      formatDateTime(mv.created_at),
      tech.get(mv.technician_id) ?? "-",
      m?.name ?? "-",
      m?.code ?? "-",
      mv.movement_type === "withdrawal" ? "Retiro" : "Devolución",
      mv.quantity,
      m?.unit ?? "",
      mv.notes ?? "",
      conf ? "Confirmado" : "Pendiente",
      conf?.profiles?.email ?? "",
      conf ? formatDateTime(conf.confirmed_at) : "",
    ];
  });
  return toCsv([header, ...rows]);
}
