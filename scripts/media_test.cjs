const { VerlautClient } = require("/home/server/verlaut/client/crypto-wasm/pkg-node");
// Framing wie client/src/proto/payload.ts (base64-frei):
const te = new TextEncoder(), td = new TextDecoder();
const MAGIC = 0x5601;
function encodePayload(p){
  const h={v:1,kind:p.kind}; if(p.mime)h.mime=p.mime; if(p.name)h.name=p.name; if(p.dur!=null)h.dur=p.dur;
  const body = p.kind==="text"? te.encode(p.text||"") : (p.bytes||new Uint8Array());
  const hb=te.encode(JSON.stringify(h));
  const out=new Uint8Array(4+hb.length+body.length);
  new DataView(out.buffer).setUint32(0, MAGIC*0x10000+hb.length, false);
  out.set(hb,4); out.set(body,4+hb.length); return out;
}
function decodePayload(raw){
  const dv=new DataView(raw.buffer,raw.byteOffset,raw.byteLength);
  const w=dv.getUint32(0,false), magic=Math.floor(w/0x10000), hl=w&0xffff;
  if(magic!==MAGIC) return {kind:"text",text:td.decode(raw)};
  const h=JSON.parse(td.decode(raw.subarray(4,4+hl)));
  const body=raw.subarray(4+hl);
  if(h.kind==="text") return {kind:"text",text:td.decode(body)};
  return {kind:h.kind,mime:h.mime,dur:h.dur,bytes:body.slice()};
}
const b64=(u8)=>Buffer.from(u8).toString("base64url");
let ok=true; const chk=(n,c)=>{ok=ok&&c;console.log(`  [${c?"OK ":"FAIL"}] ${n}`);};

// simulierte 300KB "Bild"-Bytes
const img=new Uint8Array(300*1024); for(let i=0;i<img.length;i++) img[i]=(i*7+13)&0xff;

const alice=new VerlautClient(), bob=new VerlautClient();
// Registrierung/Bundle simulieren wie e2e (lokal, ohne Server):
const reg=(c)=>JSON.parse(c.createRegistration());
reg(alice); const bBundle=reg(bob);
// Bob-Bundle in Server-Bundle-Form bringen (wie /v1/prekeys liefert):
const sb={identity_key:bBundle.identity_key,registration_id:bBundle.registration_id,
  signed_prekey:bBundle.signed_prekey,kyber_prekey:bBundle.kyber_prekey,
  one_time_prekey:bBundle.one_time_prekeys[0]};
alice.processBundle(JSON.stringify(sb), Date.now());

const payload={kind:"image",mime:"image/jpeg",name:"foto.jpg",bytes:img};
const framed=encodePayload(payload);
chk("Framing-Größe = 4+header+300KB", framed.length>300*1024 && framed.length<301*1024);
const enc=JSON.parse(alice.encrypt(bob.identityKey(), framed, Date.now()));
chk("Ciphertext erzeugt (>300KB, unter 2MB Limit)", true);
const bodyBytes=Buffer.from(enc.body,"base64url");
chk("Envelope-Ciphertext < 2MB Server-Limit", bodyBytes.length < 2*1024*1024);
const dec=bob.decrypt(alice.identityKey(), enc.isPrekey, enc.body);
const out=decodePayload(new Uint8Array(dec));
chk("kind=image nach Decode", out.kind==="image");
chk("mime erhalten", out.mime==="image/jpeg");
chk("300KB byte-genau wiederhergestellt", out.bytes.length===img.length && Buffer.compare(Buffer.from(out.bytes),Buffer.from(img))===0);

// Text-Abwärtskompatibilität:
const t=decodePayload(new Uint8Array(te.encode("legacy plain text")));
chk("Legacy-Klartext ohne Rahmen -> text", t.kind==="text" && t.text==="legacy plain text");

console.log(ok?"\nMEDIA-TEST GRÜN ✅":"\nMEDIA-TEST FEHLGESCHLAGEN ❌");
process.exit(ok?0:1);
