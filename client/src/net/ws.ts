// WebSocket-Client: Auth-Handshake + Envelope-Zustellung.
//
// Robust für Mobile: automatischer Reconnect mit Backoff (Handys trennen den
// WS beim Backgrounden/Bildschirm-aus) und eine Ausgangs-Warteschlange, damit
// Nachrichten, die während einer kurzen Trennung gesendet werden, nach dem
// Reconnect zugestellt werden. Der Server liefert beim (Re-)Connect ohnehin
// alle gepufferten Envelopes erneut aus (durable Queue).
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

interface Outgoing {
  dest: Uint8Array;
  isPrekey: boolean;
  bodyB64: string;
}

export class VerlautWs {
  private ws?: WebSocket;
  private waiter?: (f: any) => void;
  private counter = 10;
  private outbox: Outgoing[] = [];
  private alive = false;
  private backoff = 1000;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private identity: Uint8Array,
    private signer: Signer,
    private onInbound: (m: Inbound) => void,
    private onStatus: (connected: boolean) => void,
  ) {}

  async connect(): Promise<void> {
    this.alive = true;
    await this.open();
  }

  /** Sauber schließen (kein Reconnect mehr). */
  close() {
    this.alive = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }

  private open(): Promise<void> {
    return new Promise<void>((resolve) => {
      const url = location.origin.replace(/^http/, "ws") + "/v1/ws";
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        this.scheduleReconnect();
        return resolve();
      }
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      ws.onmessage = (ev) => this.route(new Uint8Array(ev.data as ArrayBuffer));
      ws.onclose = () => {
        this.onStatus(false);
        this.scheduleReconnect();
        resolve();
      };
      ws.onerror = () => {
        /* onclose folgt und übernimmt den Reconnect */
      };
      ws.onopen = async () => {
        try {
          await this.handshake();
          this.onStatus(true);
          this.backoff = 1000;
          this.flush();
        } catch {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        }
        resolve();
      };
    });
  }

  private scheduleReconnect() {
    if (!this.alive) return;
    if (this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 15000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.alive) void this.open();
    }, delay);
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

  private isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /** Verschlüsselten Envelope an `dest` senden. Wird gepuffert und (spätestens
   *  nach Reconnect) zugestellt. `body` = base64url-Ciphertext. */
  sendMessage(dest: Uint8Array, isPrekey: boolean, bodyB64: string) {
    this.outbox.push({ dest, isPrekey, bodyB64 });
    this.flush();
  }

  private flush() {
    if (!this.isOpen()) return;
    while (this.outbox.length) {
      const m = this.outbox.shift()!;
      const ciphertext = Uint8Array.from(
        atob(m.bodyB64.replace(/-/g, "+").replace(/_/g, "/")),
        (c) => c.charCodeAt(0),
      );
      this.send({
        id: ++this.counter,
        outbound: {
          version: 1,
          type: m.isPrekey ? EnvType.PREKEY : EnvType.CIPHERTEXT,
          destinationIdentityKey: m.dest,
          sourceIdentityKey: this.identity,
          destinationDeviceId: 1,
          ciphertext,
        },
      });
    }
  }
}
