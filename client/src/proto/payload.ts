// Verlaut Message-Payload — die Klartext-Nutzlast VOR der E2E-Verschlüsselung.
//
// Alles, was der Nutzer sendet (Text, Bild, Sprachnachricht), wird in EINE
// opake Byte-Nutzlast serialisiert, die dann komplett von libsignal
// verschlüsselt wird. Der Server sieht nur den Ciphertext — er kann Typ, MIME,
// Länge, nichts davon lesen. Das Rahmenformat ist bewusst simpel und
// base64-frei (kein 33%-Overhead für Medien):
//
//   [4 Byte: headerLen (BE u32)] [headerLen Byte: UTF-8 JSON-Header] [Rohbytes]
//
// Header-JSON: { v:1, kind:"text"|"image"|"audio", mime?, name?, dur? }
// - kind="text": Rohbytes = UTF-8 des Textes
// - kind="image"/"audio": Rohbytes = die (bereits herunterskalierten) Mediendaten
//
// Abwärtskompatibilität: Ältere Clients senden reinen UTF-8-Text ohne Rahmen.
// decodePayload erkennt das (kein gültiger Header) und liefert es als Text.

export type PayloadKind = "text" | "image" | "audio";

export interface Payload {
  kind: PayloadKind;
  mime?: string;
  name?: string;
  dur?: number; // Sekunden (Sprachnachricht)
  text?: string; // nur kind==="text"
  bytes?: Uint8Array; // nur Medien
}

interface Header {
  v: 1;
  kind: PayloadKind;
  mime?: string;
  name?: string;
  dur?: number;
}

const te = new TextEncoder();
const td = new TextDecoder();
const MAGIC = 0x5601; // "V" 0x01 — markiert das gerahmte Format im ersten Header-Byte-Bereich

export function encodePayload(p: Payload): Uint8Array {
  const header: Header = { v: 1, kind: p.kind };
  if (p.mime) header.mime = p.mime;
  if (p.name) header.name = p.name;
  if (typeof p.dur === "number") header.dur = p.dur;
  const body = p.kind === "text" ? te.encode(p.text ?? "") : (p.bytes ?? new Uint8Array());
  const headerBytes = te.encode(JSON.stringify(header));
  // Header-Länge steckt in 16 Bit (siehe unten). Praktisch unerreichbar
  // (Header sind winzig), aber wir sichern gegen Frame-Korruption ab.
  if (headerBytes.length >= 0x10000) throw new Error("Payload-Header zu groß");
  const out = new Uint8Array(4 + headerBytes.length + body.length);
  const dv = new DataView(out.buffer);
  // Erstes Byte-Muster dient auch als Format-Erkennung: headerLen ist klein
  // (< 2^24) -> das oberste Byte ist 0. Wir setzen stattdessen ein Magic-Prefix
  // über die obersten Bits, um reinen Text zuverlässig zu unterscheiden.
  dv.setUint32(0, MAGIC * 0x10000 + headerBytes.length, false);
  out.set(headerBytes, 4);
  out.set(body, 4 + headerBytes.length);
  return out;
}

export function decodePayload(raw: Uint8Array): Payload {
  try {
    if (raw.length < 4) throw new Error("zu kurz");
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const word = dv.getUint32(0, false);
    const magic = Math.floor(word / 0x10000);
    const headerLen = word & 0xffff;
    if (magic !== MAGIC) throw new Error("kein Verlaut-Rahmen");
    if (4 + headerLen > raw.length) throw new Error("Header-Länge ungültig");
    const header = JSON.parse(td.decode(raw.subarray(4, 4 + headerLen))) as Header;
    const body = raw.subarray(4 + headerLen);
    if (header.kind === "text") {
      return { kind: "text", text: td.decode(body) };
    }
    return {
      kind: header.kind,
      mime: header.mime,
      name: header.name,
      dur: header.dur,
      bytes: body.slice(), // eigene Kopie (löst sich vom Ciphertext-Puffer)
    };
  } catch {
    // Legacy / ungerahmt: als reinen Text interpretieren.
    return { kind: "text", text: td.decode(raw) };
  }
}
