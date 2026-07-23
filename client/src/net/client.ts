// Netzwerk-Client zum Verlaut-Server. REST für Registrierung/PreKeys/Auth,
// WSS für Nachrichten. Base64url (ohne Padding) passend zum Server.
//
// Krypto-Aufrufe (signChallenge/encrypt/...) delegieren an das WASM-Modul
// (crypto/) — dieser Client kennt nur Bytes, nie Klartext-Semantik.

export const b64 = {
  enc(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(str: string): Uint8Array {
    const s = str.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

export interface SignedPreKey { keyId: number; publicKey: Uint8Array; signature: Uint8Array }
export interface OneTimePreKey { keyId: number; publicKey: Uint8Array }
export interface PreKeyBundle {
  identityKey: Uint8Array;
  signedPreKey: SignedPreKey;
  /** Signierter Kyber-1024-PreKey (PQXDH, zwingend). */
  kyberPreKey: SignedPreKey;
  oneTimePreKey?: OneTimePreKey;
}

/** Signiert eine Server-Nonce. Implementiert vom Krypto-Modul (WASM). */
export type Signer = (nonce: Uint8Array) => Promise<Uint8Array>;

export class VerlautApi {
  constructor(private base: string) {}

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(this.base + path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return (await res.json()) as T;
  }

  /** Holt eine Nonce und liefert die signierten Auth-Header. */
  private async authHeaders(identity: Uint8Array, sign: Signer): Promise<Record<string, string>> {
    const { nonce } = await this.json<{ nonce: string }>("/v1/auth/challenge", {
      method: "POST",
      body: JSON.stringify({ identity_key: b64.enc(identity) }),
    });
    const n = b64.dec(nonce);
    const sig = await sign(n);
    return {
      "X-Identity-Key": b64.enc(identity),
      "X-Auth-Nonce": b64.enc(n),
      "X-Auth-Signature": b64.enc(sig),
    };
  }

  async register(
    identity: Uint8Array,
    spk: SignedPreKey,
    kyber: SignedPreKey,
    otpks: OneTimePreKey[],
  ): Promise<void> {
    const sk = (k: SignedPreKey) => ({
      key_id: k.keyId,
      public_key: b64.enc(k.publicKey),
      signature: b64.enc(k.signature),
    });
    await this.json("/v1/accounts/register", {
      method: "POST",
      body: JSON.stringify({
        identity_key: b64.enc(identity),
        signed_prekey: sk(spk),
        kyber_prekey: sk(kyber),
        one_time_prekeys: otpks.map((o) => ({ key_id: o.keyId, public_key: b64.enc(o.publicKey) })),
      }),
    });
  }

  async claimUsername(identity: Uint8Array, sign: Signer, username: string): Promise<void> {
    await this.json("/v1/accounts/username", {
      method: "POST",
      headers: await this.authHeaders(identity, sign),
      body: JSON.stringify({ username }),
    });
  }

  async resolveUsername(username: string): Promise<Uint8Array> {
    const r = await this.json<{ identity_key: string }>(`/v1/accounts/resolve/${encodeURIComponent(username)}`);
    return b64.dec(r.identity_key);
  }

  async fetchBundle(username: string): Promise<PreKeyBundle> {
    const r = await this.json<any>(`/v1/prekeys/${encodeURIComponent(username)}`);
    const sk = (k: any): SignedPreKey => ({ keyId: k.key_id, publicKey: b64.dec(k.public_key), signature: b64.dec(k.signature) });
    return {
      identityKey: b64.dec(r.identity_key),
      signedPreKey: sk(r.signed_prekey),
      kyberPreKey: sk(r.kyber_prekey),
      oneTimePreKey: r.one_time_prekey ? { keyId: r.one_time_prekey.key_id, publicKey: b64.dec(r.one_time_prekey.public_key) } : undefined,
    };
  }
}

// WS-Kanal: siehe net/ws.ts (Frame-Codec + Auth-Handshake) — folgt mit der
// Krypto-Integration, weil Outbound/Inbound den WASM-Ciphertext transportieren.
