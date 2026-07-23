//! Durable Zustell-Queue.
//!
//! Ablauf (verlustfrei):
//!   1. Outbound-Envelope wird IMMER zuerst persistiert (offline_envelopes).
//!   2. Ist der Empfänger online -> sofortige Zustellung über den Hub.
//!      Ist er offline -> ntfy-Push.
//!   3. Der Client bestätigt mit DeliveryAck(server_id) -> Zeile wird gelöscht.
//!   4. Nicht abgeholte Envelopes verfallen nach TTL (Reaper).
//!
//! Der Server speichert nur den opaken, prost-serialisierten Envelope-Blob,
//! die Empfänger-Queue und einen Zeitstempel. Keine Kontaktbeziehung.

use prost::Message;
use uuid::Uuid;

use crate::error::AppError;
use crate::proto::Envelope;
use crate::push;
use crate::state::AppState;

/// Nimmt einen ausgehenden Envelope an: persistieren, dann zustellen/pushen.
pub async fn accept_outbound(state: &AppState, mut env: Envelope) -> Result<(), AppError> {
    if env.destination_identity_key.len() != 33 {
        return Err(AppError::BadRequest);
    }
    if env.ciphertext.len() > state.cfg.max_envelope_bytes {
        return Err(AppError::PayloadTooLarge);
    }

    // Serverseitige Felder setzen; server_id wird erst bei Zustellung gefüllt.
    env.server_timestamp = now_ms();
    env.server_id = Vec::new();
    let payload = env.encode_to_vec();

    let expires_at = chrono::Utc::now()
        + chrono::Duration::from_std(state.cfg.offline_ttl).unwrap_or(chrono::Duration::days(30));

    let row = sqlx::query!(
        "INSERT INTO offline_envelopes (destination_identity_key, payload, expires_at)
         VALUES ($1, $2, $3)
         RETURNING id",
        &env.destination_identity_key,
        &payload,
        expires_at
    )
    .fetch_one(&state.pg)
    .await?;

    let dest = env.destination_identity_key.clone();

    // Zustellversuch an eine online Verbindung.
    env.server_id = row.id.as_bytes().to_vec();
    if !state.hub.deliver(&dest, env) {
        // Offline -> Best-Effort-Push (kein Inhalt, kein Absender).
        push::notify_new_message(state, &dest).await;
    }
    Ok(())
}

/// Alle für `identity` gepufferten Envelopes (z. B. beim WS-Connect).
/// server_id wird gesetzt, damit der Client gezielt ACKen kann.
pub async fn fetch_pending(state: &AppState, identity: &[u8]) -> Result<Vec<Envelope>, AppError> {
    let rows = sqlx::query!(
        "SELECT id, payload FROM offline_envelopes
         WHERE destination_identity_key = $1
         ORDER BY server_timestamp",
        identity
    )
    .fetch_all(&state.pg)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        match Envelope::decode(&row.payload[..]) {
            Ok(mut env) => {
                env.server_id = row.id.as_bytes().to_vec();
                out.push(env);
            }
            // Korrupter Blob: still verwerfen (kein Nutzinhalt geloggt).
            Err(_) => {
                let _ = sqlx::query!("DELETE FROM offline_envelopes WHERE id = $1", row.id)
                    .execute(&state.pg)
                    .await;
            }
        }
    }
    Ok(out)
}

/// Löscht einen zugestellten + geACKten Envelope. Die destination-Bindung
/// verhindert, dass ein Client fremde Envelopes löscht.
pub async fn ack_delete(
    state: &AppState,
    identity: &[u8],
    server_id: &[u8],
) -> Result<(), AppError> {
    let id = Uuid::from_slice(server_id).map_err(|_| AppError::BadRequest)?;
    sqlx::query!(
        "DELETE FROM offline_envelopes WHERE id = $1 AND destination_identity_key = $2",
        id,
        identity
    )
    .execute(&state.pg)
    .await?;
    Ok(())
}

/// Hintergrund-Reaper: löscht abgelaufene Envelopes. Wird periodisch gerufen.
pub async fn reap_expired(state: &AppState) -> Result<u64, AppError> {
    let res = sqlx::query!("DELETE FROM offline_envelopes WHERE expires_at < now()")
        .execute(&state.pg)
        .await?;
    Ok(res.rows_affected())
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
