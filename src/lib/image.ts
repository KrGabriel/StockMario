/**
 * Compresión de fotografías en el navegador antes de subir a Supabase Storage.
 * - Corrige orientación EXIF (createImageBitmap con imageOrientation:'from-image',
 *   con fallback a HTMLImageElement, que los navegadores modernos ya orientan).
 * - Redimensiona al lado máximo manteniendo proporción (sin deformar).
 * - Exporta WebP (calidad ~0.75); si el navegador no lo soporta, JPEG.
 * - Nunca sube el archivo original multi-megabyte.
 */

const MAX_SIDE = 1280; // ancho/alto máximo en px (el otro lado queda proporcional)
const WEBP_QUALITY = 0.75; // 70-80%
const JPEG_QUALITY = 0.8;
export const MAX_ORIGINAL_BYTES = 15 * 1024 * 1024; // límite del archivo original
const ACCEPTED = ["image/webp", "image/jpeg", "image/png", "image/heic", "image/heif", "image/gif", "image/bmp", "image/tiff"];

export interface ProcessedImage {
  blob: Blob;
  mime: "image/webp" | "image/jpeg";
  ext: "webp" | "jpg";
  width: number;
  height: number;
  bytes: number;
}

export function validateOriginalImage(file: File): string | null {
  if (!file.type || !file.type.startsWith("image/")) {
    return "El archivo seleccionado no es una imagen.";
  }
  if (file.type && !ACCEPTED.includes(file.type.toLowerCase())) {
    return `Formato de imagen no admitido (${file.type}).`;
  }
  if (file.size > MAX_ORIGINAL_BYTES) {
    return "La imagen es demasiado grande (máximo 15 MB). Tomá otra con menor resolución.";
  }
  if (file.size === 0) {
    return "El archivo de imagen está vacío o dañado.";
  }
  return null;
}

async function decodeImage(file: File): Promise<{ w: number; h: number; draw: CanvasImageSource }> {
  // Camino moderno: respeta orientación EXIF
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { w: bitmap.width, h: bitmap.height, draw: bitmap };
    } catch {
      // algunos navegadores decodifican HEIC/tiff con error: probar fallback
    }
  }
  // Fallback: HTMLImageElement (los navegadores modernos aplican EXIF al dibujar)
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("decode-failed"));
    });
    if (!img.naturalWidth || img.naturalWidth === 0) {
      throw new Error("decode-failed");
    }
    return { w: img.naturalWidth, h: img.naturalHeight, draw: img };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function processImage(file: File): Promise<ProcessedImage> {
  const validationError = validateOriginalImage(file);
  if (validationError) throw new Error(validationError);

  let src: { w: number; h: number; draw: CanvasImageSource };
  try {
    src = await decodeImage(file);
  } catch {
    throw new Error(
      "La imagen no se puede procesar en este dispositivo. Volvé a tomar la fotografía e intentá otra vez.",
    );
  }

  // Ancho máximo 1280 y alto proporcional (sin deformar). Se limita el lado
  // mayor → width ≤ 1280 y height ≤ 1280 en cualquier orientación.
  const scale = Math.min(1, MAX_SIDE / Math.max(src.w, src.h));
  const w = Math.max(1, Math.round(src.w * scale));
  const h = Math.max(1, Math.round(src.h * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No se pudo procesar la imagen en este navegador.");
  ctx.drawImage(src.draw, 0, 0, w, h);

  const toBlob = (type: string, quality: number): Promise<Blob | null> =>
    new Promise((resolve) => {
      try {
        canvas.toBlob((blob) => resolve(blob), type, quality);
      } catch {
        resolve(null);
      }
    });

  let blob = await toBlob("image/webp", WEBP_QUALITY);
  let mime: "image/webp" | "image/jpeg" = "image/webp";
  let ext: "webp" | "jpg" = "webp";

  if (!blob || blob.type !== "image/webp") {
    // Fallback JPEG si WebP no es compatible o la conversión falla
    blob = await toBlob("image/jpeg", JPEG_QUALITY);
    mime = "image/jpeg";
    ext = "jpg";
  }
  if (!blob) {
    throw new Error("No se pudo comprimir la fotografía. Probá con otra imagen.");
  }

  // Si aún así excede el objetivo, repetir con menor calidad como último recurso
  let quality = WEBP_QUALITY;
  while (mime === "image/webp" && blob.size > 3 * 1024 * 1024 && quality > 0.4) {
    quality -= 0.15;
    const smaller = await toBlob("image/webp", quality);
    if (!smaller) break;
    blob = smaller;
  }

  return { blob, mime: mime as ProcessedImage["mime"], ext, width: w, height: h, bytes: blob.size };
}
