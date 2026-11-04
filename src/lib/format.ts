const TZ = "America/Argentina/Buenos_Aries";

const dateFmt = new Intl.DateTimeFormat("es-AR", {
  timeZone: TZ,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const timeFmt = new Intl.DateTimeFormat("es-AR", {
  timeZone: TZ,
  hour: "2-digit",
  minute: "2-digit",
});

const dateHourFmt = new Intl.DateTimeFormat("es-AR", {
  timeZone: TZ,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "-";
  return dateFmt.format(new Date(iso));
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  return timeFmt.format(new Date(iso));
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  return dateHourFmt.format(new Date(iso));
}

export function formatQty(qty: number | null | undefined): string {
  if (qty === null || qty === undefined) return "-";
  return new Intl.NumberFormat("es-AR", { maximumFractionDigits: 3 }).format(qty);
}

export function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diffMs / 86_400_000);
  const hours = Math.floor(diffMs / 3_600_000);
  if (days > 0) return `hace ${days} día${days === 1 ? "" : "s"}`;
  if (hours > 0) return `hace ${hours} h`;
  const minutes = Math.max(1, Math.floor(diffMs / 60_000));
  return `hace ${minutes} min`;
}

export function randomIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
