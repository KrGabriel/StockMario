import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../lib/format";

/**
 * Captura exclusiva con la cámara del teléfono (sin galería ni input de archivos).
 * Usa navigator.mediaDevices.getUserMedia con la cámara trasera
 * (facingMode: environment). Se requiere HTTPS (Vercel) para permisos.
 * Detiene todas las pistas de video al capturar, desmontar o fallar.
 */
export default function CameraCapture({
  onCapture,
  processing,
}: {
  onCapture: (file: File) => void;
  processing: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraState, setCameraState] = useState<"idle" | "starting" | "streaming" | "error">("idle");
  const [cameraError, setCameraError] = useState("");

  function stopStream() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  }

  // Limpieza garantizada al salir del formulario o cambiar de pantalla
  useEffect(() => stopStream, []);

  async function startCamera() {
    setCameraError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraState("error");
      setCameraError("Tu navegador no es compatible con la cámara. Usá Chrome, Opera o Safari actualizados.");
      return;
    }
    setCameraState("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      if (!videoRef.current || !stream) return;
      streamRef.current = stream;
      videoRef.current.srcObject = stream;
      await videoRef.current.play().catch(() => undefined);
      setCameraState("streaming");
    } catch (e) {
      stopStream();
      setCameraState("error");
      const name = e instanceof DOMException ? e.name : "";
      if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
        setCameraError(
          "Permiso de cámara denegado. Volvé a intentarlo y aceptá el permiso en tu navegador (ícono del candado junto a la dirección).",
        );
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "NotReadableError") {
        setCameraError(
          "No se encontró una cámara disponible, o está en uso por otra aplicación. Probá con otra app cerrada o reiniciá el navegador.",
        );
      } else {
        setCameraError(`Error al iniciar la cámara: ${errorMessage(e)}`);
      }
    }
  }

  function capture() {
    const video = videoRef.current;
    if (!video || cameraState !== "streaming" || processing) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) {
      setCameraError("La imagen de la cámara aún no está lista. Probá de nuevo.");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setCameraError("No se pudo capturar la imagen en este navegador.");
      return;
    }
    ctx.drawImage(video, 0, 0, w, h);
    canvas.toBlob(
      (blob) => {
        // Detener la cámara al capturar (libera el acceso y la batería)
        stopStream();
        setCameraState("idle");
        if (!blob) {
          setCameraError("No se pudo capturar la fotografía. Probá de nuevo.");
          return;
        }
        onCapture(new File([blob], "captura.jpg", { type: "image/jpeg" }));
      },
      "image/jpeg",
      0.9,
    );
  }

  return (
    <div className="space-y-3">
      {(cameraState === "idle" || cameraState === "error") && !processing && (
        <button type="button" onClick={startCamera} className="rounded-xl bg-brand-600 px-4 py-3 text-sm font-bold text-white transition active:scale-[0.98] hover:bg-brand-700">
          📷 Abrir cámara
        </button>
      )}

      {cameraError && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{cameraError}</p>
      )}

      {cameraState === "starting" && (
        <p className="flex items-center gap-2 text-sm font-medium text-brand-700">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-brand-300 border-t-brand-700"></span>
          Activando cámara…
        </p>
      )}

      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={`w-full rounded-lg bg-slate-900 ${cameraState === "streaming" ? "block" : "hidden"}`}
      />

      {cameraState === "streaming" && !processing && (
        <div className="flex gap-2">
          <button type="button" onClick={capture} className="rounded-xl bg-brand-600 px-4 py-3 text-sm font-bold text-white transition active:scale-[0.98] hover:bg-brand-700">
            📸 Capturar foto
          </button>
          <button
            type="button"
            onClick={() => {
              stopStream();
              setCameraState("idle");
            }}
            className="btn-secondary"
          >
            Cancelar
          </button>
        </div>
      )}
    </div>
  );
}
