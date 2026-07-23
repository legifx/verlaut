// WebSocket-Client: Auth-Handshake + Envelope-Zustellung.
import { decodeFrame, encodeFrame, EnvType } from "../proto/proto";

export interface Inbound {
  source: Uint8Array; // Absender-Identity (33 B)
  isPrekey: boolean;
  ciphertext: string; // base64url (für VerlautClient.decrypt)
  serverId: Uint8Array;
}

type Signer = (nonce: Uint8Array) => Uint8Array | Promise<Uint8Array>;

const b64url = (u8: Uint8Array) =>
  btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export class VerlautWs {
  private ws?: WebSocket;
  private waiter?: (f: any) => void;
  private counter = 10;

  constructor(
    private identity: Uint8Array,
    private signer: Signer,
    private onInbound: (m: Inbound) => void,
    private onStatus: (connected: boolean) => void,
  ) {}

  async connect(): Promise<void> {
    const url = location.origin.replace(/^http/, "ws") + "/v1/ws";
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onmessage = (ev) => this.route(new Uint8Array(ev.data as ArrayBuffer));
    ws.onclose = () => this.onStatus(false);
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("WS-Verbindung fehlgeschlagen"));
    });
    await this.handshake();
    this.onStatus(true);
  }

  private route(bytes: Uint8Array) {
    const f = decodeFrame(bytes);
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      w(f);
    } else {
      this.dispatch(f);
    }
  }
  private next(): Promise<any> {
    return new Promise((r) => (this.waiter = r));
  }
  private send(obj: Record<string, unknown>) {
    this.ws!.send(encodeFrame(obj));
  }

  private async handshake() {
    this.send({ id: 1, authChallengeRequest: { identityKey: this.identity } });
    const ch = await this.next();
    const nonce: Uint8Array = ch.authChallenge.nonce;
    const sig = await this.signer(nonce);
    this.send({ id: 2, authResponse: { identityKey: this.identity, signature: sig } });
    const res = await this.next();
    if (!res.authResult || !res.authResult.ok) throw new Error("Authentifizierung fehlgeschlagen");
  }

  private dispatch(f: any) {
    const which: string | undefined = f.payload;
    if (which === "inbound") {
      const e = f.inbound;
      this.onInbound({
        source: e.sourceIdentityKey,
        isPrekey: e.type === EnvType.PREKEY,
        ciphertext: b64url(e.ciphertext),
        serverId: e.serverId,
      });
      // sofort bestätigen -> Server löscht den Puffer
      this.send({ id: ++this.counter, deliveryAck: { envelopeId: e.serverId } });
    }
    // serverAck / error: für v1 ignoriert (Zustellung ist durabel).
  }

  /** Verschlüsselten Envelope an `dest` senden. `body` = base64url-Ciphertext. */
  sendMessage(dest: Uint8Array, isPrekey: boolean, bodyB64: string) {
    const ciphertext = Uint8Array.from(atob(bodyB64.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0),
    );
    this.send({
      id: ++this.counter,
      outbound: {
        version: 1,
        type: isPrekey ? EnvType.PREKEY : EnvType.CIPHERTEXT,
        destinationIdentityKey: dest,
        sourceIdentityKey: this.identity,
        destinationDeviceId: 1,
        ciphertext,
      },
    });
  }
}
