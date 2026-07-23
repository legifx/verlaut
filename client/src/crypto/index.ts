// Verlaut Client-Krypto — dünne Fassade über libsignal.
//
// GRUNDSATZ: Hier wird KEINE Krypto implementiert. Diese Datei definiert nur
// die Schnittstelle, die die App nutzt; die Implementierung delegiert
// AUSSCHLIESSLICH an @signalapp/libsignal-client (X3DH + Double Ratchet).
//
// Alternative (empfohlen für Tauri): libsignal in Rust in `src-tauri` betreiben
// und via Tauri-Command aufrufen — dann liegt kein Schlüsselmaterial im JS-Heap.
// Die Entscheidung TS-Bindings vs. Rust-in-Tauri fällt beim Client-Ausbau.

/** Ed25519 Identity Key (roh, 32 Byte). Öffentlicher Teil ist die Server-ID. */
export type IdentityKey = Uint8Array;

/** Ein PreKey-Bundle, wie es der Server unter GET /v1/prekeys/... liefert. */
export interface PreKeyBundle {
  identityKey: IdentityKey;
  signedPreKey: { keyId: number; publicKey: Uint8Array; signature: Uint8Array };
  oneTimePreKey?: { keyId: number; publicKey: Uint8Array };
}

/** Ergebnis einer lokalen Verschlüsselung: opaker Ciphertext + Typ. */
export interface Ciphertext {
  type: "prekey" | "whisper";
  body: Uint8Array;
}

/**
 * Die von der App genutzte Krypto-Fassade. Jede Methode MUSS intern libsignal
 * aufrufen — niemals selbstgebaute Primitive.
 */
export interface VerlautCrypto {
  /** Erzeugt/lädt das lokale Identitäts-Keypair (persistiert im sicheren Store). */
  loadOrCreateIdentity(): Promise<IdentityKey>;

  /** Signiert eine Server-Nonce für die Auth-Challenge (Ed25519). */
  signChallenge(nonce: Uint8Array): Promise<Uint8Array>;

  /** Erzeugt Signed PreKey + One-Time-PreKeys für die Registrierung/Rotation. */
  generatePreKeys(count: number): Promise<{
    signedPreKey: { keyId: number; publicKey: Uint8Array; signature: Uint8Array };
    oneTimePreKeys: { keyId: number; publicKey: Uint8Array }[];
  }>;

  /** Baut aus einem PreKey-Bundle eine X3DH-Session zum Empfänger auf. */
  establishSession(recipient: IdentityKey, bundle: PreKeyBundle): Promise<void>;

  /** Verschlüsselt Klartext für eine bestehende Session (Double Ratchet). */
  encrypt(recipient: IdentityKey, plaintext: Uint8Array): Promise<Ciphertext>;

  /** Entschlüsselt einen eingehenden Envelope-Ciphertext. */
  decrypt(sender: IdentityKey, ciphertext: Ciphertext): Promise<Uint8Array>;

  /** Safety Number zur Kontaktverifikation (Phase 2). */
  safetyNumber(peer: IdentityKey): Promise<string>;
}

// TODO(client-ausbau):
//  - Implementierung `LibsignalCrypto implements VerlautCrypto` gegen
//    @signalapp/libsignal-client bzw. Tauri-Rust-libsignal.
//  - Session-/Identity-Store auf SQLCipher (Schlüssel aus OS-Keychain).
//  - Verdrahtung mit net/ (WS) und den generierten Envelope-Typen aus shared/.
export {};
