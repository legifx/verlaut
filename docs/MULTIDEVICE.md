# Multi-Device — ein Account auf Handy *und* PC

Ziel: dieselbe Verlaut-Identität (derselbe `@username`) auf mehreren Geräten
nutzen, ohne die Ende-zu-Ende-Sicherheit aufzuweichen.

## Warum „einfach den Schlüssel kopieren" NICHT reicht

Die naheliegende Idee — den privaten Identity-Key als langen Code auf das zweite
Gerät übertragen und dort importieren — **funktioniert für gleichzeitig aktive
Geräte nicht** und ist unsicher:

1. **Double Ratchet divergiert.** libsignal hält pro Konversation einen
   fortlaufenden Ratchet-Zustand. Senden zwei Geräte mit *derselben* Identität
   unabhängig an denselben Kontakt, laufen die Ratchets auseinander → der
   Empfänger kann Nachrichten nicht mehr entschlüsseln.
2. **PreKey-Kollision.** Im Server-Schema gehört pro Identität genau **ein**
   Signed-PreKey / Kyber-PreKey-Satz. Zwei Geräte würden sich gegenseitig
   überschreiben.
3. **Kompromittierung.** Ein exportierbarer Langzeit-Identity-Key, der über
   Geräte wandert, ist ein deutlich größeres Angriffsziel.

Ein reiner „Kaltbackup"-Import (nur *ein* Gerät gleichzeitig aktiv) wäre machbar,
löst aber nicht „Handy und PC parallel".

## Der korrekte Ansatz: Geräte-Fan-out (Signal-Modell)

Jedes Gerät hat seine **eigene** Identität/Schlüssel. Ein *Account* (`@username`)
ist die Menge seiner **autorisierten Geräte**. Senden bedeutet: an **jedes**
Gerät des Empfängers separat verschlüsseln.

```
@bob  ─┬─ device: phone   (IdentityKey_1, eigene Ratchets)
       └─ device: desktop (IdentityKey_2, eigene Ratchets)

Alice sendet an @bob:  verschlüsselt einmal für IdentityKey_1
                       verschlüsselt einmal für IdentityKey_2
```

Jedes Gerät hält seine eigenen, konsistenten Ratchets — nichts divergiert. Der
Server bleibt dumm: er kennt nur „diese Identity-Keys gehören zu diesem
Username" und routet die einzelnen verschlüsselten Kopien.

### Geräte verknüpfen (der „lange Key")

Die vom Nutzer gewünschte UX — ein langer, zufälliger Code zum Verknüpfen —
bildet man **sicher** so ab (der Code ist ein *Linking-Token*, **nicht** der
Identity-Key):

1. Neues Gerät erzeugt seine eigene Identität und zeigt seinen Public
   Identity-Key (als QR / langer Base64-Code).
2. Primärgerät scannt/liest ihn und **signiert** „IdentityKey_2 gehört zu
   @bob" mit dem privaten Schlüssel des Primärgeräts.
3. Diese Signatur geht an den Server (`POST /v1/devices/link`). Der Server
   verifiziert sie gegen den bereits registrierten Primärschlüssel und nimmt
   das neue Gerät in die Geräte-Menge auf.
4. Ab jetzt liefert `resolve`/`directory` **alle** Geräte-Keys; Sender
   verschlüsseln an alle.

Der Linking-Token trägt so nur eine *Autorisierung*, nie den geheimen Schlüssel.
Der private Schlüssel jedes Geräts verlässt das Gerät nie.

### Verlauf-Synchronisierung zwischen eigenen Geräten

Optional und getrennt: Ein neues Gerät sieht standardmäßig nur *neue*
Nachrichten. Alten Verlauf synchronisiert man, indem das Primärgerät ihn als
verschlüsselte Nachrichten an die eigene neue Geräte-Identität schickt
(dieselbe E2E-Maschinerie). So bleibt auch die Sync Ende-zu-Ende-verschlüsselt.

## At-rest-Schutz des Schlüssels auf dem Gerät

Der private Geräteschlüssel liegt lokal (IndexedDB, origin-isoliert). Härtung:
Verschlüsselung mit einem beim ersten Start **einmalig zufällig** erzeugten
Schlüssel, der via WebCrypto **nicht extrahierbar** (`extractable:false`) im
Browser-Keystore gehalten wird — er ist damit im laufenden Betrieb nicht
auslesbar. Optional zusätzlich passphrase-/biometrie-gebunden.

## Status

- **Design:** steht (dieses Dokument), Council-reviewt.
- **Server:** Einzel-Gerät heute vollständig; `devices/link` + Multi-Key-`resolve`
  ist der nächste, schema-kompatible Schritt (neue Tabelle `account_devices`).
- **Client:** Fan-out-Versand + Linking-UI folgen auf die Server-Erweiterung.

> Bis dahin gilt: ein Gerät pro `@username`. Ein zweites Gerät kann heute als
> **eigener** Username geführt werden.
