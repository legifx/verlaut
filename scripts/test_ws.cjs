// End-to-End WebSocket-Zustelltest gegen den LIVE-Server, mit echter
// libsignal-Crypto + echtem Frame-Protokoll. Beweist: A -> Server -> B kommt an
// und wird korrekt entschlüsselt. Nutzt Node-22 globales WebSocket + protobufjs.
const path = require("path").join(__dirname,"..","client","node_modules","protobufjs");
const protobuf = require(path);
const fs = require("fs");
const { VerlautClient } = require(require("path").join(__dirname,"..","client","crypto-wasm","pkg-node"));

const HTTP = process.env.VERLAUT_BASE || "http://localhost:8443";
const WS = HTTP.replace(/^http/, "ws") + "/v1/ws";

const protoSrc = fs.readFileSync(require("path").join(__dirname,"..","shared","proto","envelope.proto"), "utf8");
const root = protobuf.parse(protoSrc).root;
const Frame = root.lookupType("verlaut.v1.Frame");
const EnvType = { UNKNOWN: 0, PREKEY: 1, CIPHERTEXT: 2 };

const b64url = (u8) => Buffer.from(u8).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const unb64 = (s) => new Uint8Array(Buffer.from(s.replace(/-/g,"+").replace(/_/g,"/"),"base64"));
const enc = (obj) => Frame.encode(Frame.create(obj)).finish();
const dec = (buf) => Frame.decode(new Uint8Array(buf));

async function register(c){const r=await fetch(HTTP+"/v1/accounts/register",{method:"POST",headers:{"Content-Type":"application/json"},body:c.createRegistration()});if(!r.ok)throw new Error("register "+r.status);}

// Öffnet WS + führt Auth-Handshake aus. Liefert das offene Socket.
function connect(client, identity) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS);
    ws.binaryType = "arraybuffer";
    let stage = 0;
    ws.onopen = () => ws.send(enc({ id: 1, authChallengeRequest: { identityKey: identity } }));
    ws.onerror = (e) => reject(new Error("ws error"));
    ws._inbox = [];
    ws.onmessage = (ev) => {
      const f = dec(ev.data);
      if (stage === 0 && f.authChallenge) {
        const sig = client.sign(f.authChallenge.nonce);
        ws.send(enc({ id: 2, authResponse: { identityKey: identity, signature: sig } }));
        stage = 1;
      } else if (stage === 1 && f.authResult) {
        if (f.authResult.ok) { stage = 2; resolve(ws); }
        else reject(new Error("auth failed: " + f.authResult.reason));
      } else if (stage === 2) {
        ws._inbox.push(f);
        if (ws._onframe) ws._onframe(f);
      }
    };
  });
}

let ok = true; const chk = (n,c)=>{ok=ok&&c;console.log(`  [${c?"OK ":"FAIL"}] ${n}`);};

(async () => {
  const A = new VerlautClient(), B = new VerlautClient();
  await register(A); await register(B);
  const aId = A.identityKey(), bId = B.identityKey();

  console.log("1) B verbindet WS + authentifiziert");
  const bWs = await connect(B, bId);
  chk("B authentifiziert", true);
  const gotB = new Promise((res) => { bWs._onframe = (f) => f.inbound && res(f.inbound); });

  console.log("2) A verbindet WS + authentifiziert");
  const aWs = await connect(A, aId);
  chk("A authentifiziert", true);

  console.log("3) A baut Session zu B + sendet verschlüsselten Envelope");
  const bundle = await (await fetch(HTTP+"/v1/prekeys/key/"+b64url(bId))).text();
  A.processBundle(bundle, Date.now());
  const e = JSON.parse(A.encrypt(bId, new TextEncoder().encode("hallo über WS 🔒"), Date.now()));
  aWs.send(enc({ id: 10, outbound: {
    version: 1, type: e.isPrekey ? EnvType.PREKEY : EnvType.CIPHERTEXT,
    destinationIdentityKey: bId, sourceIdentityKey: aId, destinationDeviceId: 1,
    ciphertext: unb64(e.body),
  }}));
  chk("A hat Envelope gesendet", true);

  console.log("4) B wartet auf Zustellung (max 8s)");
  const inbound = await Promise.race([ gotB, new Promise((_,rej)=>setTimeout(()=>rej(new Error("TIMEOUT: keine Zustellung")),8000)) ]);
  chk("B hat Envelope über WS empfangen", !!inbound);
  const src = new Uint8Array(inbound.sourceIdentityKey);
  chk("Absender == A", b64url(src) === b64url(aId));
  const pt = B.decrypt(src, inbound.type === EnvType.PREKEY, b64url(new Uint8Array(inbound.ciphertext)));
  const text = new TextDecoder().decode(pt);
  console.log("   B liest:", JSON.stringify(text));
  chk("B entschlüsselt korrekt", text === "hallo über WS 🔒");

  aWs.close(); bWs.close();
  console.log(ok ? "\nWS-ZUSTELLUNG GRÜN ✅" : "\nWS-ZUSTELLUNG FEHLGESCHLAGEN ❌");
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error("FEHLER:", e.message||e); process.exit(1); });
