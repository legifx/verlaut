// Lokale Persistenz via IndexedDB. Identität + Kontakte + Nachrichtenverlauf.
//
// v1-Hinweis: Inhalte liegen hier gerätelokal (origin-isoliert). Der
// Identity-Private-Key liegt ebenfalls hier. At-rest-Verschlüsselung mit
// gerätespezifischem Schlüssel ist ein separater Härtungsschritt.
//
// v2: Nachrichten können Medien tragen (Bild / Sprachnachricht). Medien werden
// als ArrayBuffer gespeichert (kein base64-Overhead, IndexedDB-nativ).

import { openDB, type DBSchema } from "idb";

export type MsgKind = "text" | "image" | "audio";

export interface StoredMessage {
  id?: number;
  peerId: string; // base64url(identity)
  dir: "in" | "out";
  kind: MsgKind;
  text: string; // Textinhalt (bei Medien: leer oder Beschreibung)
  mime?: string;
  name?: string;
  dur?: number; // Sekunden (Sprachnachricht)
  media?: ArrayBuffer; // Bild-/Audiodaten
  ts: number;
}
export interface StoredContact {
  peerId: string;
  username: string;
  identity: Uint8Array;
}
export interface StoredIdentity {
  identity: Uint8Array; // serialisiertes Keypair (privat)
  registrationId: number;
  username: string;
}

interface Schema extends DBSchema {
  kv: { key: string; value: StoredIdentity };
  contacts: { key: string; value: StoredContact };
  messages: { key: number; value: StoredMessage; indexes: { "by-peer": string } };
}

const dbp = openDB<Schema>("verlaut", 2, {
  upgrade(db, oldVersion) {
    if (oldVersion < 1) {
      db.createObjectStore("kv");
      db.createObjectStore("contacts", { keyPath: "peerId" });
      const m = db.createObjectStore("messages", { keyPath: "id", autoIncrement: true });
      m.createIndex("by-peer", "peerId");
    }
    // v1->v2: bestehende Text-Nachrichten haben kein `kind`; beim Lesen wird
    // fehlendes kind als "text" behandelt (siehe normalizeMsg). Kein Rewrite
    // nötig -> keine teure Migration.
  },
});

function normalizeMsg(m: StoredMessage): StoredMessage {
  return { ...m, kind: m.kind ?? "text" };
}

export const store = {
  async saveIdentity(v: StoredIdentity) {
    (await dbp).put("kv", v, "identity");
  },
  async loadIdentity(): Promise<StoredIdentity | undefined> {
    return (await dbp).get("kv", "identity");
  },
  async saveContact(c: StoredContact) {
    (await dbp).put("contacts", c);
  },
  async loadContacts(): Promise<StoredContact[]> {
    return (await dbp).getAll("contacts");
  },
  async addMessage(m: StoredMessage): Promise<number> {
    return (await dbp).add("messages", m) as Promise<number>;
  },
  async loadMessages(peerId: string): Promise<StoredMessage[]> {
    const all = await (await dbp).getAllFromIndex("messages", "by-peer", peerId);
    return all.map(normalizeMsg);
  },
};
