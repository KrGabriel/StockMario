import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import type { Movement } from "../../lib/types";
import { formatDateTime, errorMessage } from "../../lib/format";

/**
 * Vista previa bajo demanda de la fotografía de un retiro.
 * Genera la URL firmada solo al abrir (no carga máxima las imágenes
 * del historial), con sesión del administrador sobre el bucket privado.
 */
export default function PhotoPreview({
  movement,
  techName,
  matName,
  onClose,
}: {
  movement: Movement;
  techName: string;
  matName: string;
  onClose: () => void;
}) {
  const [url, setUrl] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data, error: sError } = await supabase.storage
          .from("movement-photos")
          .createSignedUrl(movement.photo_path!, 600);
        if (sError) throw sError;
        if (!cancelled) setUrl(data.signedUrl);
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [movement.photo_path]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="card w-full max-w-md !p-4"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Fotografía del movimiento"
      >
        <div className="mb-2 flex items-start justify-between">
          <div>
            <p className="text-sm font-semibold text-slate-900">
              Foto del retiro · {techName} · {matName}
            </p>
            <p className="text-xs text-slate-500">{formatDateTime(movement.created_at)}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" aria-label="Cerrar">
            ✕
          </button>
        </div>
        {loading ? (
          <p className="py-10 text-center text-sm text-slate-500">Cargando imagen…</p>
        ) : error ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        ) : (
          <img src={url} alt={`Fotografía del retiro de ${matName}`} className="max-h-[60vh] w-full rounded-lg object-contain" loading="lazy" />
        )}
        {url && !error && (
          <a href={url} target="_blank" rel="noreferrer" className="mt-3 text-center block text-sm text-brand-600 underline">
            Abrir en tamaño completo
          </a>
        )}
      </div>
    </div>
  );
}
