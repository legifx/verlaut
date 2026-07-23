// E2E-Test: zwei WASM-Clients (Alice, Bob) reden über den LAUFENDEN Server
// Ende-zu-Ende-verschlüsselt (PQXDH). Registrierung + Bundle-Fetch echt via HTTPS.
const { VerlautClient } = require("/home/server/verlaut/client/crypto-wasm/pkg-node");

const BASE = process.env.VERLAUT_BASE || "http://localhost:8443";
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64url = (u8) =>
  Buffer.from(u8).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let ok = true;
const check = (name, cond) => { ok = ok && cond; console.log(`  [${cond ? "OK " : "FAIL"}] ${name}`); };

async function register(client) {
  const r = await fetch(BASE + "/v1/accounts/register", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: client.createRegistration(),
  });
  if (!r.ok) throw new Error("register " + r.status);
}

async function main() {
  const alice = new VerlautClient();
  const bob = new VerlautClient();
  console.log("1) Registrierung beider Clients gegen den Server");
  await register(alice);
  await register(bob);
  check("beide registriert", true);

  console.log("2) Alice holt Bobs PreKey-Bundle vom Server + baut Session (PQXDH)");
  const bobId = bob.identityKey();
  const br = await fetch(BASE + "/v1/prekeys/key/" + b64url(bobId));
  check("bundle-fetch 200", br.ok);
  const bundleJson = await br.text();
  check("bundle enthält kyber_prekey", bundleJson.includes("kyber_prekey"));
  const now = Date.now();
  alice.processBundle(bundleJson, now);
  check("session aufgebaut", true);

  console.log("3) Alice -> Bob (Erstnachricht, PreKeySignalMessage)");
  const m1 = "Hallo Bob — Ende-zu-Ende + Post-Quantum, im Browser.";
  const e1 = JSON.parse(alice.encrypt(bobId, enc.encode(m1), now));
  check("erste Nachricht ist PreKey-Typ", e1.isPrekey === true);
  const p1 = dec.decode(bob.decrypt(alice.identityKey(), e1.isPrekey, e1.body));
  console.log("     Bob liest:", JSON.stringify(p1));
  check("Bob entschlüsselt korrekt", p1 === m1);

  console.log("4) Bob -> Alice (Antwort, etablierte Session)");
  const m2 = "Angekommen, entschlüsselt. Grüße zurück!";
  const e2 = JSON.parse(bob.encrypt(alice.identityKey(), enc.encode(m2), now));
  check("Antwort ist KEINE PreKey-Message mehr", e2.isPrekey === false);
  const p2 = dec.decode(alice.decrypt(bobId, e2.isPrekey, e2.body));
  console.log("     Alice liest:", JSON.stringify(p2));
  check("Alice entschlüsselt korrekt", p2 === m2);

  console.log("\nRESULT:", ok ? "ALLE E2E-TESTS GRÜN ✅" : "FEHLER ❌");
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("FEHLER:", e); process.exit(1); });
