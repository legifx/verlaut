#!/usr/bin/env python3
"""Server-Smoke-Test: beweist Registrierung, Signatur-Challenge-Auth,
Username-Claim, PreKey-Fetch (OTPK-Verbrauch) gegen einen laufenden
verlaut-server. KEIN libsignal — testet nur die Server-Kontrakte."""
import base64, json, sys, urllib.request
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8443"

def b64(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()
def raw_pub(k):
    return k.public_key().public_bytes(serialization.Encoding.Raw,
                                       serialization.PublicFormat.Raw)
def post(path, body, headers=None):
    req = urllib.request.Request(BASE+path, data=json.dumps(body).encode(),
        headers={"Content-Type":"application/json", **(headers or {})}, method="POST")
    with urllib.request.urlopen(req, timeout=8) as r: return r.status, json.loads(r.read() or b"{}")
def get(path):
    with urllib.request.urlopen(BASE+path, timeout=8) as r: return r.status, json.loads(r.read() or b"{}")

def challenge_headers(idk, priv):
    """Holt Nonce, signiert sie, liefert die Auth-Header."""
    _, resp = post("/v1/auth/challenge", {"identity_key": b64(idk)})
    nonce = base64.urlsafe_b64decode(resp["nonce"] + "==")
    sig = priv.sign(nonce)
    return {"X-Identity-Key": b64(idk), "X-Auth-Nonce": b64(nonce), "X-Auth-Signature": b64(sig)}

ok = True
def check(name, cond):
    global ok; ok = ok and cond
    print(f"  [{'OK ' if cond else 'FAIL'}] {name}")

# --- Alice registriert sich ---
alice = Ed25519PrivateKey.generate()
a_idk = raw_pub(alice)
spk_pub = bytes(32)  # Platzhalter-X25519 (Server prüft nur die Signatur darüber)
spk_pub = raw_pub(Ed25519PrivateKey.generate())  # 32 zufällige Byte
spk_sig = alice.sign(spk_pub)
otpks = [{"key_id": i, "public_key": b64(raw_pub(Ed25519PrivateKey.generate()))} for i in range(1, 4)]

print("1) Registrierung Alice")
st, r = post("/v1/accounts/register", {
    "identity_key": b64(a_idk),
    "signed_prekey": {"key_id": 1, "public_key": b64(spk_pub), "signature": b64(spk_sig)},
    "one_time_prekeys": otpks,
})
check("register 200", st == 200 and r.get("ok") is True)

print("2) Registrierung mit KAPUTTER Signatur muss scheitern")
st2 = 0
try:
    bad = Ed25519PrivateKey.generate().sign(spk_pub)  # falscher Signierer
    post("/v1/accounts/register", {"identity_key": b64(raw_pub(Ed25519PrivateKey.generate())),
        "signed_prekey": {"key_id":1,"public_key":b64(spk_pub),"signature":b64(bad)},
        "one_time_prekeys": []})
except urllib.error.HTTPError as e: st2 = e.code
check("bad signature -> 400", st2 == 400)

print("3) Username-Claim (Signatur-Challenge)")
st, r = post("/v1/accounts/username", {"username": "alice"}, challenge_headers(a_idk, alice))
check("username claim 200", st == 200 and r.get("username") == "alice")

print("4) Username-Claim mit FALSCHER Signatur muss 401 geben")
st4 = 0
try:
    h = challenge_headers(a_idk, alice)
    h["X-Auth-Signature"] = b64(Ed25519PrivateKey.generate().sign(b"x"*32))  # falsch
    post("/v1/accounts/username", {"username":"eve"}, h)
except urllib.error.HTTPError as e: st4 = e.code
check("forged auth -> 401", st4 == 401)

print("5) resolve username -> identity_key")
st, r = get("/v1/accounts/resolve/alice")
check("resolve matches", st == 200 and r.get("identity_key") == b64(a_idk))

print("6) PreKey-Bundle holen (verbraucht 1 OTPK)")
st, r = get("/v1/prekeys/alice")
check("bundle has signed_prekey", st == 200 and "signed_prekey" in r)
check("bundle has one_time_prekey", r.get("one_time_prekey") is not None)
first_otpk = r["one_time_prekey"]["key_id"]

print("7) OTPK-Verbrauch: nächster Fetch liefert ANDEREN OTPK")
_, r2 = get("/v1/prekeys/alice")
check("otpk differs (verbraucht)", r2.get("one_time_prekey", {}).get("key_id") != first_otpk)

print("8) Nonce ist single-use: zweite Verwendung derselben Nonce scheitert")
h = challenge_headers(a_idk, alice)
post("/v1/accounts/username", {"username":"alice"}, h)  # 1. Nutzung ok
st8 = 0
try: post("/v1/accounts/username", {"username":"alice2"}, h)  # 2. Nutzung -> 401
except urllib.error.HTTPError as e: st8 = e.code
check("nonce replay -> 401", st8 == 401)

print("\nRESULT:", "ALLE TESTS GRÜN ✅" if ok else "FEHLER ❌")
sys.exit(0 if ok else 1)
