# Verlaut Client (Gerüst)

React + TypeScript + Vite in einer Tauri-v2-Shell. Krypto via **libsignal**,
lokale Persistenz via **SQLite + SQLCipher** (Schlüssel aus der OS-Keychain).

> Status: **Struktur + Krypto-Interface stehen.** Die eigentliche
> libsignal-/SQLCipher-/UI-Implementierung ist der nächste Phase-1-Schritt.

## Struktur
```
src/
  crypto/   VerlautCrypto-Fassade über libsignal (siehe index.ts)
  store/    Zustand + verschlüsselte lokale SQLite (SQLCipher, Tauri)
  net/      WS-Client (Reconnect), Envelope-Codec (protobuf aus shared/)
  ui/       Chat-UI (ruhig, lesbar; dezentes Glass, Verschlüsselungsstatus sichtbar)
  App.tsx
src-tauri/  Rust-Shell (optional libsignal + SQLCipher in Rust)
```

## Onboarding-Flow (Ziel: <60 s)
1. Keygen (Ed25519 Identity Key) — lokal, nie zum Server.
2. Username wählen → `POST /v1/accounts/register` + `POST /v1/accounts/username`.
3. Recovery-Phrase (Identity-Key-Backup) mit deutlicher Warnung anzeigen.

## Nächste Schritte
- `LibsignalCrypto` gegen `@signalapp/libsignal-client` implementieren
  (oder libsignal-Rust in `src-tauri` und via Command aufrufen — bevorzugt,
  hält Schlüssel aus dem JS-Heap).
- Envelope-Typen generieren: `npm run proto` (protobuf aus `../shared/proto`).
- WS-Client: Auth-Handshake (ChallengeRequest→Response), Outbound/Inbound,
  DeliveryAck, Reconnect mit Backoff.
- SQLCipher-Store für Nachrichten/Sessions; Schlüssel aus OS-Keychain.
- Chat-UI mit sichtbarem, dezentem Verschlüsselungsstatus (Schloss + Verifikation).

## Krypto-Regel
Keine eigene Kryptographie. Ausschließlich libsignal. Siehe `src/crypto/index.ts`.
