# Verlaut Mobile (serverlos) — Design & ehrliche Grenzen

Ziel: eine Variante für Endnutzer **ohne eigenen Server** — die App läuft nur
auf den Geräten, Nachrichten Ende-zu-Ende-verschlüsselt, und kommen auch an,
wenn das Empfängergerät zwischendurch aus war.

Dieses Dokument beschreibt das Design ehrlich — inklusive der physikalischen
Grenze, die man nicht wegprogrammieren kann.

## Die harte Wahrheit über „serverlos + offline-zustellbar"

„Der Empfänger ist offline, soll die Nachricht aber trotzdem bekommen" heißt per
Definition: **irgendjemand muss die Nachricht halten, bis der Empfänger wieder
online ist.** Wenn beide Geräte gleichzeitig aus sind, kann *niemand* etwas
zustellen — das ist keine Software-, sondern eine Verfügbarkeitsgrenze.

„Serverlos" kann daher nur heißen: **kein zentraler, betreiberbetriebener
Server** — nicht „keine erreichbare Komponente überhaupt". Realistische Optionen:

| Modell | Offline-Zustellung | Aufwand / Realität |
|---|---|---|
| **Direkt P2P** (beide online) | ❌ nur wenn beide gleichzeitig online | einfach, aber unbrauchbar für Chat |
| **Store-and-Forward über Peer-Mailboxen** (Briar-Prinzip) | ⚠️ nur wenn ein gemeinsamer Kontakt online ist | komplex, unzuverlässig in kleinen Netzen |
| **Verteilte Mailbox (DHT / mehrere Relays)** | ✅ solange *ein* Relay online ist | Relays sind wieder „Server", nur föderiert |
| **Push-Mailbox pro Nutzer** (leichtgewichtiger Relay) | ✅ zuverlässig | genau das, was Verlaut self-hosted schon ist |

**Schlussfolgerung:** Zuverlässige, konsistente Offline-Zustellung braucht eine
dauerhaft erreichbare Store-and-Forward-Komponente. Der ehrliche Weg für
„Endnutzer ohne eigenen Server" ist deshalb **nicht** „gar kein Server", sondern
**ein Relay, das der Nutzer nicht selbst betreiben muss**.

## Empfohlenes Design: gehosteter dummer Relay + reine Client-Krypto

Verlaut hat bereits genau die richtige Eigenschaft: der Server ist **blind**
(nur Ciphertext). Für die Endnutzer-Variante ändert sich also **nichts an der
Sicherheit** — nur am Betrieb:

1. **Ein (oder wenige) öffentliche, dumme Relays** — betrieben als Gemeingut,
   föderierbar. Sie sehen weiterhin nur opake Envelopes (kein Klartext, keine
   Kontakte). Kompromittierung eines Relays bricht **nicht** die E2E-Sicherheit.
2. **Client wählt sein Relay** (Standard-Liste + „eigenes eintragen"). Wer will,
   trägt später sein self-hosted Verlaut ein — nahtloser Übergang.
3. **Reine App-Installation** (Android zuerst): keine Server-Einrichtung,
   Onboarding = Username wählen, fertig. Der private Schlüssel entsteht lokal.

Damit erreicht man das eigentliche Nutzerziel (installieren, privat schreiben,
Offline-Zustellung) **ohne** falsche Versprechen.

## Wenn es wirklich relay-frei sein muss

Für den Fall „keinerlei zentrale Komponente" ist **Briar** das ehrliche
Referenzmodell (Tor-Hidden-Services, Store-and-Forward über gemeinsame
Kontakte). Trade-off: Zustellung nur, wenn Sender/Empfänger oder ein geteilter
Kontakt gleichzeitig online sind. Das ist ein anderes Produkt mit anderem
Nutzungsgefühl — bewusst abzuwägen, nicht zu verschweigen.

## Status

- **Sicherheitskern:** vorhanden und getestet (identisch zur self-hosted App).
- **Was fehlt:** Relay-Auswahl-UI, eine kleine öffentliche Relay-Instanz und der
  Android-Store-fähige Build. Architektonisch ist der Weg klar; es ist
  Betriebs-/Produktarbeit, keine Krypto-Neuentwicklung.

> Bewusst **kein** vorgetäuschter „fertiger, unknackbarer, komplett serverloser"
> Messenger. Was hier steht, ist der real umsetzbare, ehrliche Plan.
