// Medien-Helfer: Bild-Herunterskalierung + Sprachaufnahme. Rein clientseitig,
// keine Netz-Zugriffe. Ziel: Medien klein genug halten, dass ein
// verschlüsselter Envelope bequem über WebSocket + Offline-Queue passt.

/** Max. Kantenlänge und JPEG-Qualität fürs Herunterskalieren von Fotos. */
const MAX_EDGE = 1280;
const JPEG_Q = 0.82;

export interface EncodedImage {
  bytes: Uint8Array;
  mime: string;
  name: string;
}

/** Skaliert ein Bild auf <= MAX_EDGE und kodiert als JPEG. Fällt bei Fehlern
 *  auf die Originaldatei zurück (z. B. bei bereits kleinen/exotischen Formaten). */
export async function downscaleImage(file: File): Promise<EncodedImage> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const blob: Blob = await new Promise((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob leer"))), "image/jpeg", JPEG_Q),
    );
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: "image/jpeg", name: "foto.jpg" };
  } catch {
    return { bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type || "image/jpeg", name: file.name || "bild" };
  }
}

/** Wählt ein vom Browser unterstütztes Opus-Audioformat für MediaRecorder. */
function pickAudioMime(): string {
  const cands = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/mp4"];
  for (const c of cands) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(c)) return c;
  }
  return "audio/webm";
}

export interface Recorder {
  stop: () => Promise<{ bytes: Uint8Array; mime: string; dur: number }>;
  cancel: () => void;
}

/** Startet eine Sprachaufnahme. Wirft, wenn kein Mikro-Zugriff besteht. */
export async function startRecording(): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = pickAudioMime();
  const rec = new MediaRecorder(stream, { mimeType: mime });
  const chunks: BlobPart[] = [];
  const started = Date.now();
  rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
  rec.start();

  const cleanup = () => stream.getTracks().forEach((t) => t.stop());

  return {
    stop: () =>
      new Promise((resolve) => {
        rec.onstop = async () => {
          cleanup();
          const blob = new Blob(chunks, { type: mime });
          resolve({
            bytes: new Uint8Array(await blob.arrayBuffer()),
            mime,
            dur: Math.max(1, Math.round((Date.now() - started) / 1000)),
          });
        };
        rec.stop();
      }),
    cancel: () => {
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
      cleanup();
    },
  };
}

/** Erzeugt eine Object-URL aus gespeicherten Medienbytes zur Anzeige/Wiedergabe. */
export function mediaUrl(data: ArrayBuffer | Uint8Array, mime: string): string {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  return URL.createObjectURL(new Blob([buf as unknown as BlobPart], { type: mime }));
}
