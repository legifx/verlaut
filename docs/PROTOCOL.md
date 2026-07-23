# Verlaut — Protokoll (Phase 1)

> Ziel dieses Dokuments: Ein Auditor kann den Wire- und Auth-Flow nachvollziehen,
> ohne den Code zu lesen. Kanonische Quelle des Wire-Formats:
> [`shared/proto/envelope.proto`](../shared/proto/envelope.proto).

## Identität

- Eine Identität ist ein **Ed25519-Schlüsselpaar**, clientseitig generiert.
- Der **Identity Public Key** (32 Byte roh) ist die einzige serverseitige
  Kennung. Kein E-Mail, keine Telefonnummer, keine sonstige PII.
- Ein **Username** (unique, änderbar) ist optionaler, menschenlesbarer Alias.
  Der Server hält nur `username -> identity_key` und `identity_key -> username`.
  Er speichert **keine** Kontaktbeziehungen zwischen Usern.

## Transportkanäle

| Kanal | Zweck | Sichtbarkeit für den Server |
|---|---|---|
| **HTTPS (REST)** | Registrierung, Username-Claim, PreKey-Upload/-Fetch | Nur öffentliche Keys + PreKey-Bundles (per Design öffentlich) |
| **WSS (WebSocket)** | Echtzeit-Zustellung, Auth-Challenge, ACKs | Nur `Envelope`-Hüllen (Ciphertext + Routing) |

Beides läuft hinter Caddy (Auto-TLS) bzw. Tailscale. Der Server sieht **nie**
Klartext-Nachrichteninhalte.

## Krypto — nichts davon ist selbstgebaut

Sämtliche kryptographische Arbeit liegt bei **libsignal**:

- **X3DH** für den initialen Sitzungsaufbau (asynchron, via PreKey-Bundle).
- **Double Ratchet** für Forward Secrecy + Post-Compromise Security je Nachricht.
- Der Server implementiert **keinerlei** Krypto-Primitive. Er transportiert und
  puffert opake Bytes und prüft Ed25519-Signaturen zur Authentisierung.

## Auth — Signatur-Challenge (keine Passwörter, keine Sessions mit PII)

```
Client                                  Server
  |  AuthChallengeRequest{identity_key}   |
  |-------------------------------------->|
  |                                       |  nonce := 32 random bytes
  |                                       |  cache[identity_key] = (nonce, expiry=+30s)
  |        AuthChallenge{nonce, expiry}   |
  |<--------------------------------------|
  |  sig := Ed25519_sign(identity_priv,   |
  |                      nonce)           |
  |  AuthResponse{identity_key, sig}      |
  |-------------------------------------->|
  |                       verify(identity_key, nonce, sig)  (konstante Zeit)
  |                       nonce single-use, sofort invalidieren
  |            AuthResult{ok}             |
  |<--------------------------------------|
```

- Nonce ist **single-use** und **kurzlebig** (≤30 s), serverseitig nur in Redis
  (ephemer), nie in Postgres.
- Signaturprüfung in **konstanter Zeit** (libsignal / `ed25519-dalek`-Verify ist
  konstant-zeit für die Signatur; Token-Vergleiche via `subtle`).
- Erfolgreiche Auth bindet die WS-Verbindung an `identity_key`. Ausgehende
  Envelopes müssen `source_identity_key == authentifizierter Key` erfüllen,
  sonst `UNAUTHENTICATED`.

## Registrierung & Username-Claim (REST)

```
POST /v1/accounts/register
  body: { identity_key, signed_prekey, one_time_prekeys[], signature }
  -> Server prüft Signatur über das Bundle mit identity_key.
  -> Legt/aktualisiert Account (nur Keys). Kein Klartext-Metadatum.

POST /v1/accounts/username
  auth: Signatur-Challenge (s. o.)
  body: { username }
  -> Claim, falls frei. Unique-Constraint in Postgres. Änderbar.
```

## PreKey-Flow (REST)

```
POST /v1/prekeys            (auth)   Upload/Rotation von signed prekey + OTPKs
GET  /v1/prekeys/{username_or_key}   Fetch EINES Bundles (verbraucht 1 OTPK)
```

- **PreKey-Draining-Schutz:** `GET /v1/prekeys` ist rate-limited pro Aufrufer
  (Phase 2: tower-governor). Läuft der OTPK-Vorrat leer, liefert der Server das
  Bundle ohne OTPK (nur signed prekey) — der X3DH funktioniert weiter mit
  reduzierter Vorwärtssicherheit für die erste Nachricht, wie bei Signal.
- Bundle-Signaturen werden clientseitig gegen den Identity Key geprüft.

## Nachrichtenfluss (Zustellung)

```
1. A: GET /v1/prekeys/bob   -> Bundle B
2. A: libsignal X3DH -> Session, verschlüsselt lokal (Double Ratchet)
3. A: WS Frame{outbound: Envelope{ dest=B, source=A, ciphertext }}
4. Server: ServerAck; Envelope in Bs Queue (Redis; Postgres-Fallback offline)
5a. B online: Server -> Frame{inbound: Envelope}; B: DeliveryAck; Server löscht sofort
5b. B offline: Envelope in Postgres mit TTL; ntfy-Push "neue Nachricht"
                (kein Inhalt, kein Absender im Push)
6. B kommt online: pending Envelopes werden zugestellt, dann DeliveryAck-Löschung
```

### Aufbewahrung / TTL

- Zugestellt + geACKt → **sofort** gelöscht.
- Offline gepuffert → Postgres, **30 Tage TTL**, danach vom Reaper gelöscht.
- Keine Access-Logs, keine IP-Speicherung, keine Zustell-Historie.

## Was der Server NIEMALS sieht / speichert

- Klartext-Nachrichteninhalte
- Kontaktlisten / Wer-mit-wem
- Telefonnummern / E-Mails
- (ab Phase 2) den Absender einer Nachricht (Sealed Sender)

## Versionierung

`Envelope.version` und `package verlaut.v1`. Breaking Changes erhöhen die
Paketversion; der Server kann mehrere Versionen parallel bedienen.
