# Verlaut — Bedrohungsmodell

> Status: Gerüst (Phase 1). Wird in Phase 2 vervollständigt (Sealed Sender,
> Padding, Verifikation). Dieses Dokument sagt ehrlich, **was Verlaut schützt
> und was ausdrücklich nicht.**

## Schutzziele
- **Vertraulichkeit der Inhalte:** Nur Sender und Empfänger lesen Nachrichten
  (E2E via libsignal: X3DH + Double Ratchet). Der Server nie.
- **Forward Secrecy / Post-Compromise Security:** Pro-Nachricht-Schlüssel
  (Double Ratchet). Ein späterer Schlüsselklau entschlüsselt keine alten
  Nachrichten.
- **Metadaten-Minimierung:** Keine Kontaktlisten, keine PII, keine Access-Logs,
  keine IP-Speicherung, kurze Aufbewahrung (ACK/TTL).
- **Keine PII-Identität:** Registrierung ohne Telefon/E-Mail.

## Angreifermodelle

| Angreifer | Schutz durch Verlaut |
|---|---|
| Passiver Netz-Mitleser (WSS) | Sieht nur TLS-Ciphertext. Inhalt+Session geschützt. |
| Kompromittierter/neugieriger Server-Betreiber | Sieht opake Blobs, PreKeys, Empfänger-Queue, Zeitpunkte. **Keinen Inhalt.** Phase 1: kennt den Absender (Klartext-`source`). **Phase 2: Sealed Sender behebt das.** |
| DB-Diebstahl | Nur opake Envelopes (TTL-begrenzt) + öffentliche Keys. Keine Historie, kein Klartext. |
| Man-in-the-Middle beim Sitzungsaufbau | Signed-PreKey-Signatur wird gegen Identity Key geprüft. **Safety Numbers/Key-Verification (Phase 2)** schließen die verbleibende Lücke (Betreiber tauscht Identity Key). |

## Explizit NICHT geschützt (ehrlich benannt)
- **Kompromittiertes Endgerät.** Wer das Gerät kontrolliert, liest Klartext.
  Lokale DB ist at-rest via SQLCipher verschlüsselt (Schlüssel in der
  OS-Keychain), aber gegen ein aktives Malware-Endgerät hilft das nicht.
- **Traffic-Analyse über Timing/Größe (Phase 1).** Ohne Padding sind
  Nachrichtengrößen sichtbar. **Padding auf feste Blöcke kommt in Phase 2.**
- **Absender-Anonymität (Phase 1).** Der Server kennt den Absender bis
  Sealed Sender (Phase 2) aktiv ist.
- **Globaler Netzwerkbeobachter, der beide Endpunkte sieht.** Verkehrs­
  korrelation (wer sendet, wann jemand empfängt) ist kein Designziel.
- **Verfügbarkeit unter Ziel-DoS.** Rate Limiting (Phase 2) mildert, garantiert
  aber keine Verfügbarkeit.

## Vertrauensanker
- **libsignal** (unveränderte offizielle Implementierung) für die Krypto.
- **Identity Key** des Kontakts — verifizierbar per Safety Number (Phase 2).
- Reproduzierbare Client-Builds als Ziel (Phase 4), damit Nutzer prüfen können,
  dass das ausgelieferte Binary dem Quellcode entspricht.
