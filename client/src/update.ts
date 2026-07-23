// In-App-Update — rein self-hosted. Der Service Worker vergleicht die vom
// EIGENEN Server ausgelieferten Assets. Ändern sich die Dateien auf dem Server
// (neuer Build deployed), meldet der SW "waiting" -> wir zeigen ein Popup.
// Keine externen Update-Quellen, kein App-Store, keine Telemetrie.
//
// virtual:pwa-register wird von vite-plugin-pwa zur Build-Zeit bereitgestellt.
import { registerSW } from "virtual:pwa-register";

type Listener = (available: boolean) => void;
let listeners: Listener[] = [];
let apply: (reload?: boolean) => Promise<void> = async () => {};
let pending = false;

export function initUpdates() {
  apply = registerSW({
    immediate: true,
    onNeedRefresh() {
      pending = true;
      listeners.forEach((l) => l(true));
    },
    onRegisteredSW(_url, reg) {
      // Regelmäßig serverseitig auf neue Version prüfen (alle 30 min), damit ein
      // laufender Client ein Update auch ohne Neustart bemerkt.
      if (reg) setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
    },
  });
}

/** Registriert einen Callback für "Update verfügbar?". Liefert sofort den
 *  aktuellen Stand nach. Rückgabe: Unsubscribe. */
export function onUpdateAvailable(cb: Listener): () => void {
  listeners.push(cb);
  cb(pending);
  return () => {
    listeners = listeners.filter((l) => l !== cb);
  };
}

/** Wendet das wartende Update an und lädt die App neu. */
export function applyUpdate() {
  void apply(true);
}
