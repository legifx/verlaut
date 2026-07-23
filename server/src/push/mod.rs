//! Self-hosted ntfy-Push. Der Push enthält AUSSCHLIESSLICH den Hinweis
//! "neue Nachricht" — kein Inhalt, kein Absender, kein Zähler. Der Client
//! verbindet sich daraufhin per WS und holt die gepufferten Envelopes.

use crate::accounts::b64_encode;
use crate::state::AppState;

/// Topic = base64url(Empfänger-Identity). Der ntfy-Server ist self-hosted;
/// die Empfänger-Identität kennt der Server ohnehin fürs Routing. Es fließt
/// also keine zusätzliche Metadateninformation ab. Der Payload bleibt leer.
fn topic_for(identity: &[u8]) -> String {
    format!("verlaut_{}", b64_encode(identity))
}

pub async fn notify_new_message(state: &AppState, identity: &[u8]) {
    let url = format!("{}/{}", state.cfg.ntfy_base_url.trim_end_matches('/'), topic_for(identity));
    // Fehler hier sind nicht fatal: Push ist Best-Effort, Zustellung passiert
    // beim nächsten WS-Connect ohnehin. Nur ins Log, ohne sensible Daten.
    let res = state
        .http
        .post(&url)
        .header("Title", "Verlaut")
        .header("Priority", "default")
        .body("neue Nachricht")
        .send()
        .await;
    if let Err(e) = res {
        tracing::warn!(error = %e, "ntfy-Push fehlgeschlagen (nicht fatal)");
    }
}
