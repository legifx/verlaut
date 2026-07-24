# Verlaut

**Der privateste Messenger, den du selbst hosten kannst.** Ende-zu-Ende-
verschlüsselt, post-quantum, ohne Telefonnummer, ohne Klartext auf dem Server,
ohne Logs — läuft komplett auf **deinem** Server. Clients für **Android** (APK)
und **PC/Windows/Linux** (installierbare Web-App). Bilder, Sprachnachrichten,
Text. Multi-Device pro Account.

> Krypto vollständig über **[libsignal](https://github.com/signalapp/libsignal)**
> (PQXDH = X3DH + Kyber-1024, Double Ratchet). **Keine eigene Kryptographie.**
> Lizenz: **AGPL-3.0-or-later**.

---

## Warum Verlaut?

Die meisten „privaten" Messenger laufen trotzdem über fremde Server. Verlaut
dreht das um: **du betreibst den Server**, und selbst der sieht nichts außer
opaken Ciphertext-Hüllen.

| Prinzip | Umsetzung |
|---|---|
| **Keine eigene Krypto** | Alles via libsignal (dieselbe Basis wie Signal), inkl. Post-Quantum-PQXDH. |
| **Dummer Server** | Kein Klartext, keine Nachrichtenhistorie, keine Kontaktlisten. Nur PreKey-Bundles + kurzlebige Zustell-Queue. |
| **Keine PII** | Identität = ein Ed25519-Schlüssel + frei wählbarer Username. Keine Telefonnummer, keine E-Mail. |
| **Zero Logs by Design** | Keine Access-Logs, keine IP-Speicherung, 30-Tage-TTL auf Offline-Nachrichten. |
| **Self-hosted first** | Ein `docker compose up`, dahinter Tailscale oder ein Reverse-Proxy mit TLS. |
| **Offen & prüfbar** | AGPL-3.0, kompletter Quellcode, reproduzierbares Ziel. |

---

## Features

- 🔒 **E2E-Verschlüsselung** (libsignal PQXDH + Double Ratchet) — Post-Quantum.
- 💬 **Text, Bilder, Sprachnachrichten** — Medien werden vor dem Versand
  verschlüsselt; der Server sieht nie, dass es überhaupt ein Bild ist.
- 👥 **Nutzerverzeichnis** — in einer kleinen privaten Runde sehen alle
  einander und können direkt schreiben (abschaltbar).
- 📱 **Android-App (APK)** + 💻 **Desktop-App (PWA)** — installieren, fertig.
- 🔁 **In-App-Updates** — die App meldet selbst, wenn *dein* Server eine neue
  Version ausliefert. Keine App-Stores, keine externen Update-Server.
- 🔗 **Multi-Device** — ein Account auf Handy **und** PC (siehe
  [`docs/MULTIDEVICE.md`](docs/MULTIDEVICE.md)).
- 🚫 **Keine Telefonnummer, keine Werbe-IDs, keine Analytics.**

---

## Architektur

```
┌─────────────────────────┐        WSS (nur Ciphertext)        ┌──────────────────────────────┐
│  Client (Android / PWA)  │  ───────────────────────────────► │        Verlaut-Server        │
│                          │                                    │          (Rust/Axum)         │
│  libsignal (WASM)        │   • PreKey-Bundle holen            │                              │
│  PQXDH + Double Ratchet  │   • verschlüsselte Envelopes       │  • WS-Router + Präsenz (Hub) │
│  IndexedDB (lokal)       │   • Auth via Signatur-Challenge    │  • PreKey-Store  (Postgres)  │
│  Kamera / Mikrofon / UI  │                                    │  • Zustell-Queue (Postgres)  │
└─────────────────────────┘                                    │  • Nonces        (Redis)     │
                                                                │  • Push          (ntfy)      │
                                                                └──────────────────────────────┘
                                              davor: Tailscale (HTTPS) oder Caddy (Auto-TLS)
```

Der Server ist bewusst **zustandsarm und blind**: Er kennt nur öffentliche
Schlüssel, verteilt PreKey-Bundles für den Sitzungsaufbau und puffert
verschlüsselte Envelopes, bis der Empfänger online ist (dann Zustellung +
Löschen). Kein Nachrichtentext, keine Metadaten über *wer mit wem* jenseits des
reinen Routings, das für die Zustellung nötig ist.

Tiefer:
[`docs/PROTOCOL.md`](docs/PROTOCOL.md) ·
[`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) ·
[`docs/MULTIDEVICE.md`](docs/MULTIDEVICE.md) ·
[`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md)

---

## Monorepo

```
server/    Rust + Axum — Relay, PreKeys, Queue, Push, Nutzerverzeichnis
client/    React + TS + Vite (PWA) — libsignal-WASM, Medien, UI
android/   Gradle-loser WebView-APK-Wrapper (aapt2/d8/apksigner)
desktop/   Electron-Container für Windows/Linux/Mac (echte Download-App)
shared/    envelope.proto — gemeinsames Wire-Format
deploy/    docker-compose + Caddy + .env.example
docs/      PROTOCOL / THREAT_MODEL / MULTIDEVICE / SELF_HOSTING
scripts/   E2E- und Medien-Tests (Node), Smoke-Tests (Python)
```

---

## Schnellstart (Linux-Server)

Du brauchst **Docker** (mit Compose) und – empfohlen – **[Tailscale](https://tailscale.com)**
für einfaches, privates HTTPS ohne offene Ports. Auch ohne Server-Vorwissen machbar.

### 1. Repo holen

```bash
git clone https://github.com/<dein-user>/verlaut.git
cd verlaut
```

### 2. Konfiguration anlegen

```bash
cp deploy/.env.example deploy/.env
# deploy/.env öffnen und ein starkes POSTGRES_PASSWORD setzen.
# Die übrigen Defaults passen für den Tailnet-Betrieb.
```

### 3. Stack starten

```bash
cd deploy
docker compose up -d --build
```

Das baut den Server, startet Postgres/Redis/ntfy und liefert die fertige
Web-App aus. (Der erste Build dauert ein paar Minuten.)

### 4. Privat & mit HTTPS erreichbar machen (Tailscale)

Kamera und Sprachnachrichten brauchen einen **Secure Context (HTTPS)**. Am
einfachsten über Tailscale — es stellt automatisch ein gültiges Zertifikat aus:

```bash
tailscale up
# leitet HTTPS in deinem Tailnet auf den lokalen Server-Port:
tailscale serve --bg --https 8444 http://127.0.0.1:8443
```

Deine App-Adresse ist dann z. B. `https://<hostname>.<tailnet>.ts.net:8444` —
**nur** für deine eigenen Geräte im Tailnet erreichbar.

> Alternative ohne Tailscale: eigene Domain + Caddy (Auto-TLS). Siehe
> [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md) und `deploy/Caddyfile`.

### 5. Apps installieren

Öffne `https://…ts.net:8444/download` auf dem jeweiligen Gerät:

- **Android:** APK herunterladen und installieren (einmalig „unbekannte
  Quellen" für den Browser erlauben).
- **Windows:** die `.zip`-App herunterladen, entpacken, `Verlaut.exe` starten
  (portabel, keine Installation; unsigniert → SmartScreen einmal bestätigen).
- **Linux / Mac / alternativ Windows:** in Chrome/Edge über *App installieren* —
  Verlaut läuft als eigenständige Desktop-App. Native Pakete via `desktop/`.

Beim ersten Start: Username wählen → fertig. Dein privater Schlüssel wird
**lokal auf dem Gerät** erzeugt und verlässt es nie.

---

## Android-APK selbst bauen

Die ausgelieferte APK zeigt auf deinen Server. Willst du sie mit einer eigenen
Server-Adresse (oder frisch) bauen, brauchst du ein Android SDK
(`build-tools`, `platforms`) und ein JDK:

```bash
cd android
export ANDROID_SDK_ROOT=/pfad/zum/android-sdk
./build.sh "https://<hostname>.<tailnet>.ts.net:8444"
# Ergebnis: android/verlaut.apk  (signiert mit Debug-Key)
```

Der Build ist **Gradle-los** (nur `aapt2`, `javac`, `d8`, `apksigner`) und
damit klein und nachvollziehbar. Die App ist ein schlanker, gehärteter
WebView-Container um die self-hosted PWA — die gesamte Krypto läuft in der PWA.

---

## Web-App bauen (Entwicklung)

```bash
cd client
npm install
npm run wasm     # baut das libsignal-WASM (einmalig; braucht Rust + wasm-pack)
npm run dev      # Dev-Server
npm run build    # Produktions-Build nach client/dist  (vom Server ausgeliefert)
```

Tests (gegen einen laufenden Server):

```bash
node scripts/e2e_node.cjs      # Zwei Clients reden E2E-verschlüsselt (PQXDH)
node scripts/media_test.cjs    # 300 KB Bild byte-genau durch die Krypto
```

---

## Sicherheit in Kürze

- **Krypto:** ausschließlich libsignal (PQXDH/Kyber-1024 + Double Ratchet).
  Wir schreiben **keine** eigene Kryptographie.
- **Server-Wissen:** öffentliche Identity-Keys, PreKey-Bundles, kurzlebige
  verschlüsselte Envelopes. Kein Klartext, keine Historie.
- **Auth:** passwortlos per Signatur-Challenge (Server-Nonce → Client-Signatur,
  single-use, konstante Zeit).
- **Transport:** strikte CSP (nur eigene Origin), HTTPS, Tailnet-Isolation.
- **At-rest (Client):** Inhalte liegen gerätelokal (origin-isoliert). Eine
  zusätzliche gerätegebundene At-rest-Verschlüsselung ist ein geplanter
  Härtungsschritt — siehe [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md).

Verlaut wurde **nicht** unabhängig auditiert. Nutze es entsprechend bewusst.
Verantwortungsvolle Meldungen von Sicherheitsproblemen sind willkommen.

---

## Status

**Fertig & getestet:** dummer Relay-Server, Registrierung/Username/Verzeichnis,
PreKey-Upload/-Fetch/-Rotation, durable Offline-Queue + TTL, WS-Zustellung,
E2E-Text **und Medien** (Bild/Sprachnachricht), PWA + Android-APK, In-App-Update,
docker-compose/Caddy, E2E- und Medien-Tests (`scripts/`).

**In Arbeit:** vollständige Multi-Device-Fan-out-Zustellung (Design steht,
siehe [`docs/MULTIDEVICE.md`](docs/MULTIDEVICE.md)), natives Desktop-Paket,
gerätegebundene At-rest-Verschlüsselung, Sicherheits-Audit.

---

## Lizenz

**AGPL-3.0-or-later** — siehe [`LICENSE`](LICENSE). Wer Verlaut als Dienst
betreibt, muss den (ggf. veränderten) Quellcode zugänglich machen. Das hält das
Projekt offen und prüfbar.
