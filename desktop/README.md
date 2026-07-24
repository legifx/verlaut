# Verlaut Desktop (Windows / Linux / Mac)

Schlanke **Electron**-App, die die self-hosted Verlaut-PWA als eigenständiges
Desktop-Fenster lädt — inkl. Kamera/Mikrofon (Secure Context über die
HTTPS-Origin deines Servers). Die gesamte Krypto läuft in der PWA; dieser
Container liefert nur Fenster, Icon und Medien-Freigabe.

## Bauen

Voraussetzung: **Node.js**. Dann:

```bash
cd desktop
./build.sh "https://<hostname>.<tailnet>.ts.net:8444" win32
# Ergebnis: desktop/verlaut-win32.zip  (entpacken -> Verlaut.exe starten)
```

Für Linux/Mac statt `win32` einfach `linux` bzw. `darwin` angeben.

Das Skript installiert Electron + `@electron/packager` lokal, lädt die
Plattform-Binaries und packt alles. Es ist **kein Installer** — die App ist
portabel: ZIP entpacken, `Verlaut.exe` (bzw. `Verlaut`) starten.

## Hinweise

- **Unsigniert:** Windows-SmartScreen warnt beim ersten Start („Unbekannter
  Herausgeber"). Für signierte Builds ein Code-Signing-Zertifikat einbinden.
- **Server-URL:** ist zur Build-Zeit eingebettet, zur Laufzeit über die
  Umgebungsvariable `VERLAUT_URL` überschreibbar.
- Das PC-Gerät muss dieselbe Server-Origin erreichen wie die App erwartet
  (z. B. im selben Tailnet).
