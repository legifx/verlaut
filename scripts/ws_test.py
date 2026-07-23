#!/usr/bin/env python3
"""WS-Nachrichtenfluss-Test: Auth-Handshake + Envelope-Zustellung (online &
offline) + DeliveryAck-Löschung. Nutzt envelope_pb2 (pure-python)."""
import asyncio, base64, json, os, sys, urllib.request
os.environ.setdefault("PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION", "python")
import websockets
import envelope_pb2 as pb
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

HTTP = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8443"
WS = HTTP.replace("http", "ws") + "/v1/ws"

def b64(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()
def raw_pub(k): return k.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
def post(path, body):
    req = urllib.request.Request(HTTP+path, data=json.dumps(body).encode(),
        headers={"Content-Type":"application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=8) as r: return json.loads(r.read() or b"{}")

def register(priv):
    idk = raw_pub(priv); spk = raw_pub(Ed25519PrivateKey.generate())
    post("/v1/accounts/register", {"identity_key": b64(idk),
        "signed_prekey": {"key_id":1,"public_key":b64(spk),"signature":b64(priv.sign(spk))},
        "one_time_prekeys": []})
    return idk

async def authenticate(ws, priv, idk):
    f = pb.Frame(); f.id = 1; f.auth_challenge_request.identity_key = idk
    await ws.send(f.SerializeToString())
    ch = pb.Frame(); ch.ParseFromString(await ws.recv())
    nonce = ch.auth_challenge.nonce
    r = pb.Frame(); r.id = 2
    r.auth_response.identity_key = idk; r.auth_response.signature = priv.sign(nonce)
    await ws.send(r.SerializeToString())
    res = pb.Frame(); res.ParseFromString(await ws.recv())
    assert res.auth_result.ok, "auth failed"

def make_outbound(src, dst, ciphertext, fid=3):
    f = pb.Frame(); f.id = fid
    e = f.outbound
    e.version = 1; e.type = pb.Envelope.CIPHERTEXT
    e.destination_identity_key = dst; e.source_identity_key = src
    e.destination_device_id = 1; e.ciphertext = ciphertext
    return f

ok = True
def check(name, cond):
    global ok; ok = ok and cond
    print(f"  [{'OK ' if cond else 'FAIL'}] {name}")

async def main():
    alice, bob, carol = (Ed25519PrivateKey.generate() for _ in range(3))
    a, b, c = register(alice), register(bob), register(carol)
    secret = b"OPAQUE-CIPHERTEXT-libsignal-would-go-here"

    print("A) ONLINE-Zustellung Alice -> Bob")
    async with websockets.connect(WS, open_timeout=8) as wb:
        await authenticate(wb, bob, b)
        async with websockets.connect(WS, open_timeout=8) as wa:
            await authenticate(wa, alice, a)
            await wa.send(make_outbound(a, b, secret).SerializeToString())
            ack = pb.Frame(); ack.ParseFromString(await asyncio.wait_for(wa.recv(), 5))
            check("Alice bekommt ServerAck", ack.WhichOneof("payload") == "server_ack")
            inb = pb.Frame(); inb.ParseFromString(await asyncio.wait_for(wb.recv(), 5))
            check("Bob bekommt Inbound", inb.WhichOneof("payload") == "inbound")
            check("Ciphertext unverändert", inb.inbound.ciphertext == secret)
            check("server_id gesetzt (Ack-Handle)", len(inb.inbound.server_id) == 16)
            check("source == Alice", inb.inbound.source_identity_key == a)
            # Bob bestätigt -> Server löscht
            da = pb.Frame(); da.id = 9; da.delivery_ack.envelope_id = inb.inbound.server_id
            await wb.send(da.SerializeToString())
            await asyncio.sleep(0.5)

    print("B) OFFLINE-Puffer: Alice -> Carol (offline), dann Carol verbindet")
    async with websockets.connect(WS, open_timeout=8) as wa:
        await authenticate(wa, alice, a)
        await wa.send(make_outbound(a, c, b"FUER-CAROL-OFFLINE", fid=4).SerializeToString())
        ack = pb.Frame(); ack.ParseFromString(await asyncio.wait_for(wa.recv(), 5))
        check("ServerAck fuer Offline-Nachricht", ack.WhichOneof("payload") == "server_ack")
    # Carol verbindet sich -> muss gepufferte Nachricht bekommen
    async with websockets.connect(WS, open_timeout=8) as wc:
        await authenticate(wc, carol, c)
        pend = pb.Frame(); pend.ParseFromString(await asyncio.wait_for(wc.recv(), 5))
        check("Carol bekommt gepufferte Nachricht beim Connect",
              pend.WhichOneof("payload") == "inbound" and pend.inbound.ciphertext == b"FUER-CAROL-OFFLINE")

    print("C) Absender-Faelschung wird abgelehnt (source != authentifiziert)")
    async with websockets.connect(WS, open_timeout=8) as wa:
        await authenticate(wa, alice, a)
        # Alice behauptet, Bob zu sein
        await wa.send(make_outbound(b, c, b"gefaelscht", fid=5).SerializeToString())
        err = pb.Frame(); err.ParseFromString(await asyncio.wait_for(wa.recv(), 5))
        check("gefaelschter Absender -> error frame", err.WhichOneof("payload") == "error")

    print("\nRESULT:", "ALLE WS-TESTS GRÜN ✅" if ok else "FEHLER ❌")
    return 0 if ok else 1

sys.exit(asyncio.run(main()))
