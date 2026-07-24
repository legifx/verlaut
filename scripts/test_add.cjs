// Test des Add-Flows über die ECHTEN HTTP-Endpunkte des Live-Servers:
// register -> username(claim via Challenge/Sign) -> directory -> resolve -> prekey-bundle.
const { VerlautClient } = require(require("path").join(__dirname,"..","client","crypto-wasm","pkg-node"));
const BASE = process.env.VERLAUT_BASE || "http://localhost:8443";
const b64url = (u8) => Buffer.from(u8).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const b64d = (s)=>{const t=s.replace(/-/g,"+").replace(/_/g,"/");return new Uint8Array(Buffer.from(t+"===".slice((t.length+3)%4),"base64"));};
let ok=true; const chk=(n,c)=>{ok=ok&&c;console.log(`  [${c?"OK ":"FAIL"}] ${n}`);};

async function register(c){const r=await fetch(BASE+"/v1/accounts/register",{method:"POST",headers:{"Content-Type":"application/json"},body:c.createRegistration()});if(!r.ok)throw new Error("register "+r.status);}
async function claim(c,username){
  const id=b64url(c.identityKey());
  const r1=await fetch(BASE+"/v1/auth/challenge",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({identity_key:id})});
  const nonce=b64d((await r1.json()).nonce);
  const sig=c.sign(nonce);
  const r2=await fetch(BASE+"/v1/accounts/username",{method:"POST",headers:{"Content-Type":"application/json","X-Identity-Key":id,"X-Auth-Nonce":b64url(nonce),"X-Auth-Signature":b64url(sig)},body:JSON.stringify({username})});
  return r2.status;
}

(async()=>{
  const A=new VerlautClient(), B=new VerlautClient();
  await register(A); await register(B);
  chk("beide registriert", true);
  const sa=await claim(A,"zz_testa"); const sb=await claim(B,"zz_testb");
  console.log("   username-claim status:",sa,sb);
  chk("username-claim A == 200", sa===200);
  chk("username-claim B == 200", sb===200);

  const dir=(await (await fetch(BASE+"/v1/directory")).json()).users;
  const names=dir.map(u=>u.username);
  console.log("   directory:",names.join(", "));
  chk("directory enthält zz_testa", names.includes("zz_testa"));
  chk("directory enthält zz_testb", names.includes("zz_testb"));

  // A addet B: resolve username -> identity
  const rr=await fetch(BASE+"/v1/accounts/resolve/zz_testb");
  chk("resolve zz_testb == 200", rr.ok);
  const bIdFromResolve=(await rr.json()).identity_key;
  chk("resolve liefert Bs identity_key", bIdFromResolve===b64url(B.identityKey()));

  // A holt Bs PreKey-Bundle über den peerId-Key (wie die App: /v1/prekeys/key/{peerId})
  const peerId=b64url(B.identityKey());
  const rb=await fetch(BASE+"/v1/prekeys/key/"+peerId);
  chk("prekey-bundle fetch == 200", rb.ok);
  const bundleTxt=await rb.text();
  A.processBundle(bundleTxt, Date.now());
  chk("A baut Session zu B aus Bundle", true);
  const enc=JSON.parse(A.encrypt(B.identityKey(), new TextEncoder().encode("hi"), Date.now()));
  chk("A verschlüsselt erste Nachricht (isPrekey)", enc.isPrekey===true);

  console.log(ok?"\nADD-FLOW GRÜN ✅":"\nADD-FLOW FEHLGESCHLAGEN ❌");
  process.exit(ok?0:1);
})().catch(e=>{console.error("FEHLER:",e);process.exit(1);});
