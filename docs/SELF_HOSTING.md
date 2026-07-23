# Verlaut selbst hosten

Diese Anleitung richtet einen vollständigen Verlaut-Stack ein. Alles läuft auf
deinem Server; kein Google/Apple/Dritter in der Kette.

## Varianten

| Variante | TLS | Erreichbarkeit | Für wen |
|---|---|---|---|
| **Öffentliche Domain** | Caddy Auto-TLS (Let's Encrypt) | weltweit | öffentliche Community |
| **Tailscale** | interne CA / MagicDNS | nur Tailnet | privater Betrieb, zwei Betreiber |

## Schnellstart (öffentliche Domain)
1. DNS `A/AAAA` auf den Server zeigen lassen.
2. `deploy/.env` mit `VERLAUT_DOMAIN` + `VERLAUT_ALLOWED_ORIGIN` füllen.
3. `docker compose -f deploy/docker-compose.yml up -d --build`.
4. Client auf `https://<domain>` konfigurieren.

Details, sqlx-Offline-Schritt und Verifikation: [`deploy/README.md`](../deploy/README.md).

## Was der Betreiber sieht (und was nicht)
- **Sieht:** verschlüsselte Envelopes (opak), PreKey-Bundles (öffentlich per
  Design), Empfänger-Queue-Schlüssel, grobe Zustellzeitpunkte.
- **Sieht NICHT:** Nachrichteninhalte, Kontaktlisten/Wer-mit-wem,
  Telefonnummern/E-Mails; ab Phase 2 auch nicht den Absender (Sealed Sender).

## Betrieb & Wartung
- **Backups:** Nur `pgdata` enthält (kurzlebige) Envelopes — ein Verlust ist
  unkritisch, Nachrichten liegen ohnehin nur bis zum ACK/TTL vor. Kein Backup
  von Klartext nötig, weil es keinen gibt.
- **Logs:** Standardmäßig aus (Caddy discard, Postgres minimal). Nicht
  wieder einschalten, wenn Metadaten-Minimierung das Ziel ist.
- **Updates:** `git pull && docker compose up -d --build`.

## Ressourcenhinweis (Home-Server)
Der Rust-Build (libsignal-nah, LTO) und der Docker-Stack erzeugen deutliche
I/O-Last. Auf schwacher/alter Root-Platte den **Build auf einer schnellen
Platte** durchführen (oder auf einem VPS bauen) und nur das fertige Image
deployen.
