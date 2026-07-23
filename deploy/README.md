# Verlaut — Deployment

## Voraussetzungen
- Docker + Docker Compose v2
- Eine Domain (öffentlich) **oder** ein Tailscale-Setup (MagicDNS)

## 1. Konfiguration
```bash
cp deploy/.env.example deploy/.env
$EDITOR deploy/.env          # Domain, Origin, Passwort setzen
```

## 2. sqlx Offline-Daten erzeugen (einmalig / bei Query-Änderungen)
Die Server-Queries sind **compile-time-checked**. Für den Docker-Build ohne
laufende DB müssen die Offline-Daten (`server/.sqlx/`) committet sein:

```bash
# lokal, mit temporärer DB:
docker compose -f deploy/docker-compose.yml up -d postgres
cd server
export DATABASE_URL="postgres://verlaut:<PW>@localhost:5432/verlaut"
cargo install sqlx-cli --no-default-features --features postgres,rustls
sqlx migrate run
cargo sqlx prepare            # erzeugt server/.sqlx/  -> committen
```
> Ohne `server/.sqlx/` schlägt `cargo build` im Dockerfile fehl (SQLX_OFFLINE=true).

## 3. Stack starten
```bash
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml ps
```

## 4. Verifikation (Definition of Done, Phase 1)
```bash
# Nur Ciphertext auf der Leitung:
sudo tcpdump -i any -A 'port 443' | grep -i "hallo"      # darf NICHTS zeigen

# DB enthält keine Klartexte, nur opake Blobs:
docker compose -f deploy/docker-compose.yml exec postgres \
  psql -U verlaut -c "SELECT length(payload) FROM offline_envelopes LIMIT 5;"
```

## Betriebsprinzipien
- **Redis** hat kein Persistenz-Volume (Presence/Nonces sind flüchtig).
- **Postgres** puffert nur opake Envelopes mit 30-Tage-TTL (Reaper räumt).
- **Caddy** schreibt keine Access-Logs (`log { output discard }`).
- Der `server`-Container exponiert keinen Port direkt — nur über Caddy.
