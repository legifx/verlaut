// App-Orchestrierung: Onboarding, Kontakte, User-Directory, Session-Aufbau,
// Nachrichten (Text + Medien). Der Server sieht ausschließlich Ciphertext.
import { create } from "zustand";
import { initCrypto, VerlautClient } from "../crypto/verlaut";
import { VerlautWs, type Inbound } from "../net/ws";
import { store, type StoredMessage, type MsgKind } from "../store/db";
import { decodePayload, encodePayload, type Payload } from "../proto/payload";
import { downscaleImage } from "../media";

const te = new TextEncoder();
const b64e = (u8: Uint8Array) =>
  btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64d = (s: string) => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "===".slice((t.length + 3) % 4));
  const o = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i);
  return o;
};

// Nicht-serialisierbarer Laufzeitzustand (außerhalb des UI-Stores).
let client: VerlautClient | null = null;
let ws: VerlautWs | null = null;
let myIdentity: Uint8Array = new Uint8Array();
const peerIdentity: Record<string, Uint8Array> = {}; // peerId -> identity(33B)
const sessions = new Set<string>();

export interface DirectoryEntry {
  username: string;
  peerId: string;
}

interface AppState {
  booted: boolean;
  me: { username: string; peerId: string } | null;
  connected: boolean;
  contacts: Record<string, { username: string }>;
  directory: DirectoryEntry[];
  activePeer: string | null;
  messages: Record<string, StoredMessage[]>;
  error: string | null;
}
export const useApp = create<AppState>(() => ({
  booted: false,
  me: null,
  connected: false,
  contacts: {},
  directory: [],
  activePeer: null,
  messages: {},
  error: null,
}));
const set = useApp.setState;
const get = useApp.getState;

// ---- HTTP (same-origin) ----
async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r;
}
async function authHeaders(): Promise<Record<string, string>> {
  const idB64 = b64e(myIdentity);
  const r = await post("/v1/auth/challenge", { identity_key: idB64 });
  const nonce = b64d((await r.json()).nonce);
  const sig = client!.sign(nonce);
  return { "X-Identity-Key": idB64, "X-Auth-Nonce": b64e(nonce), "X-Auth-Signature": b64e(sig) };
}

async function registerFreshPreKeys() {
  await fetch("/v1/accounts/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: client!.createRegistration(),
  }).then((r) => {
    if (!r.ok) throw new Error("register " + r.status);
  });
}

async function connectWs() {
  ws = new VerlautWs(
    myIdentity,
    (nonce) => client!.sign(nonce),
    handleInbound,
    (connected) => set({ connected }),
  );
  await ws.connect();
}

async function handleInbound(m: Inbound) {
  try {
    const peerId = b64e(m.source);
    peerIdentity[peerId] = m.source;
    const pt = client!.decrypt(m.source, m.isPrekey, m.ciphertext);
    sessions.add(peerId); // Session ist nach Empfang etabliert
    const payload = decodePayload(pt);
    if (!get().contacts[peerId]) {
      const uname = get().directory.find((d) => d.peerId === peerId)?.username || "";
      set((s) => ({ contacts: { ...s.contacts, [peerId]: { username: uname } } }));
      store.saveContact({ peerId, username: uname, identity: m.source });
      // Absender noch namenlos? Directory neu laden, um den @username zu füllen.
      if (!uname) void refreshDirectory();
    }
    await appendMessage(peerId, payloadToStored(peerId, "in", payload));
  } catch (e) {
    console.error("Entschlüsselung fehlgeschlagen", e);
  }
}

function payloadToStored(peerId: string, dir: "in" | "out", p: Payload): StoredMessage {
  const base = { peerId, dir, ts: Date.now() };
  if (p.kind === "text") return { ...base, kind: "text", text: p.text || "" };
  return {
    ...base,
    kind: p.kind as MsgKind,
    text: "",
    mime: p.mime,
    name: p.name,
    dur: p.dur,
    media: p.bytes ? p.bytes.slice().buffer : undefined,
  };
}

async function appendMessage(peerId: string, msg: StoredMessage) {
  const id = await store.addMessage(msg);
  const withId = { ...msg, id };
  set((s) => ({ messages: { ...s.messages, [peerId]: [...(s.messages[peerId] || []), withId] } }));
}

async function ensureSession(peerId: string) {
  if (sessions.has(peerId)) return;
  const r = await fetch("/v1/prekeys/key/" + peerId);
  if (!r.ok) throw new Error("Bundle nicht gefunden (" + r.status + ")");
  client!.processBundle(await r.text(), Date.now());
  sessions.add(peerId);
}

// ---- öffentliche Aktionen ----
export async function boot() {
  await initCrypto();
  const saved = await store.loadIdentity();
  if (saved) {
    client = VerlautClient.fromIdentity(saved.identity, saved.registrationId);
    myIdentity = client.identityKey();
    const peerId = b64e(myIdentity);
    set({ me: { username: saved.username, peerId } });
    const cs = await store.loadContacts();
    const contacts: Record<string, { username: string }> = {};
    for (const c of cs) {
      contacts[c.peerId] = { username: c.username };
      peerIdentity[c.peerId] = c.identity;
    }
    const messages: Record<string, StoredMessage[]> = {};
    for (const c of cs) messages[c.peerId] = await store.loadMessages(c.peerId);
    set({ contacts, messages });
    try {
      await registerFreshPreKeys(); // frische PreKeys (alte In-Memory sind weg)
      await connectWs();
      await refreshDirectory();
    } catch (e: any) {
      set({ error: String(e?.message || e) });
    }
  }
  set({ booted: true });
}

export async function createAccount(username: string) {
  set({ error: null });
  try {
    client = new VerlautClient();
    myIdentity = client.identityKey();
    await registerFreshPreKeys();
    await post("/v1/accounts/username", { username }, await authHeaders());
    await store.saveIdentity({
      identity: client.exportIdentity(),
      registrationId: client.registrationId(),
      username,
    });
    set({ me: { username, peerId: b64e(myIdentity) } });
    await connectWs();
    await refreshDirectory();
  } catch (e: any) {
    set({ error: String(e?.message || e) });
    throw e;
  }
}

/** Holt die Liste aller registrierten Nutzer vom Server (kleine private
 *  Userbase). Fällt still zurück, falls der Server den Endpoint nicht kennt. */
export async function refreshDirectory() {
  try {
    const r = await fetch("/v1/directory");
    if (!r.ok) return;
    const rows: Array<{ username: string; identity_key: string }> = (await r.json()).users || [];
    const me = get().me?.peerId;
    const directory: DirectoryEntry[] = [];
    for (const row of rows) {
      if (!row.username) continue;
      const identity = b64d(row.identity_key);
      const peerId = b64e(identity);
      if (peerId === me) continue; // sich selbst nicht listen
      peerIdentity[peerId] = identity;
      directory.push({ username: row.username, peerId });
    }
    directory.sort((a, b) => a.username.localeCompare(b.username));
    set({ directory });
    // Namen für bereits bekannte Kontakte nachtragen (z. B. wenn zuerst eine
    // Nachricht von einem noch unbenannten Absender kam).
    set((s) => {
      const contacts = { ...s.contacts };
      let changed = false;
      for (const d of directory) {
        if (contacts[d.peerId] && contacts[d.peerId].username !== d.username) {
          contacts[d.peerId] = { username: d.username };
          if (peerIdentity[d.peerId]) {
            store.saveContact({ peerId: d.peerId, username: d.username, identity: peerIdentity[d.peerId] });
          }
          changed = true;
        }
      }
      return changed ? { contacts } : {};
    });
  } catch {
    /* offline / kein Directory -> ignorieren */
  }
}

export async function addContact(username: string) {
  set({ error: null });
  const r = await fetch("/v1/accounts/resolve/" + encodeURIComponent(username));
  if (!r.ok) {
    set({ error: "Unbekannter Username" });
    return;
  }
  const identity = b64d((await r.json()).identity_key);
  startChat(username, identity);
}

/** Öffnet (und persistiert) einen Chat mit einem bekannten Nutzer. */
export function startChat(username: string, identity: Uint8Array) {
  const peerId = b64e(identity);
  peerIdentity[peerId] = identity;
  store.saveContact({ peerId, username, identity });
  set((s) => ({
    contacts: { ...s.contacts, [peerId]: { username } },
    messages: { ...s.messages, [peerId]: s.messages[peerId] || [] },
    activePeer: peerId,
  }));
}

export function selectPeer(peerId: string) {
  set({ activePeer: peerId });
}

async function sendPayload(peerId: string, payload: Payload) {
  await ensureSession(peerId);
  const bytes = encodePayload(payload);
  const enc = JSON.parse(client!.encrypt(peerIdentity[peerId], bytes, Date.now()));
  ws!.sendMessage(peerIdentity[peerId], enc.isPrekey, enc.body);
  await appendMessage(peerId, payloadToStored(peerId, "out", payload));
}

export async function sendText(text: string) {
  const peerId = get().activePeer;
  if (!peerId || !text.trim()) return;
  try {
    await sendPayload(peerId, { kind: "text", text });
  } catch (e: any) {
    set({ error: String(e?.message || e) });
  }
}

export async function sendImage(file: File) {
  const peerId = get().activePeer;
  if (!peerId) return;
  try {
    const img = await downscaleImage(file);
    await sendPayload(peerId, { kind: "image", mime: img.mime, name: img.name, bytes: img.bytes });
  } catch (e: any) {
    set({ error: String(e?.message || e) });
  }
}

export async function sendAudio(bytes: Uint8Array, mime: string, dur: number) {
  const peerId = get().activePeer;
  if (!peerId) return;
  try {
    await sendPayload(peerId, { kind: "audio", mime, dur, bytes });
  } catch (e: any) {
    set({ error: String(e?.message || e) });
  }
}
