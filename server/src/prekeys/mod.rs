//! PreKey-Bundle Fetch + Rotation/Nachfüllen.
//!
//! Fetch verbraucht atomar EINEN One-Time-PreKey (FOR UPDATE SKIP LOCKED),
//! damit derselbe OTPK nie zweimal ausgegeben wird. Läuft der Vorrat leer,
//! kommt das Bundle ohne OTPK (nur Signed PreKey) — wie bei Signal.

use axum::extract::{Path, State};
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::accounts::{b64_decode, b64_encode, AuthedIdentity, OneTimePreKeyJson, SignedPreKeyJson, verify_signature};
use crate::error::AppError;
use crate::state::AppState;

#[derive(Serialize)]
pub struct BundleResp {
    pub identity_key: String,
    pub registration_id: i32,
    pub signed_prekey: SignedPreKeyOut,
    /// Signierter Kyber-1024-PreKey (PQXDH, zwingend).
    pub kyber_prekey: SignedPreKeyOut,
    /// Kann null sein, wenn der OTPK-Vorrat erschöpft ist.
    pub one_time_prekey: Option<OneTimePreKeyOut>,
}
#[derive(Serialize)]
pub struct SignedPreKeyOut {
    pub key_id: i32,
    pub public_key: String,
    pub signature: String,
}
#[derive(Serialize)]
pub struct OneTimePreKeyOut {
    pub key_id: i32,
    pub public_key: String,
}

async fn build_bundle(state: &AppState, identity: &[u8]) -> Result<BundleResp, AppError> {
    let acct = sqlx::query!(
        "SELECT registration_id FROM accounts WHERE identity_key = $1",
        identity
    )
    .fetch_optional(&state.pg)
    .await?
    .ok_or(AppError::NotFound)?;

    let spk = sqlx::query!(
        "SELECT key_id, public_key, signature FROM signed_prekeys WHERE identity_key = $1",
        identity
    )
    .fetch_optional(&state.pg)
    .await?
    .ok_or(AppError::NotFound)?;

    let kyber = sqlx::query!(
        "SELECT key_id, public_key, signature FROM kyber_prekeys WHERE identity_key = $1",
        identity
    )
    .fetch_optional(&state.pg)
    .await?
    .ok_or(AppError::NotFound)?;

    // Atomar EINEN OTPK entnehmen (falls vorhanden).
    let otpk = sqlx::query!(
        "DELETE FROM one_time_prekeys
         WHERE id = (
            SELECT id FROM one_time_prekeys
            WHERE identity_key = $1
            ORDER BY id
            FOR UPDATE SKIP LOCKED
            LIMIT 1
         )
         RETURNING key_id, public_key",
        identity
    )
    .fetch_optional(&state.pg)
    .await?;

    Ok(BundleResp {
        identity_key: b64_encode(identity),
        registration_id: acct.registration_id,
        signed_prekey: SignedPreKeyOut {
            key_id: spk.key_id,
            public_key: b64_encode(&spk.public_key),
            signature: b64_encode(&spk.signature),
        },
        kyber_prekey: SignedPreKeyOut {
            key_id: kyber.key_id,
            public_key: b64_encode(&kyber.public_key),
            signature: b64_encode(&kyber.signature),
        },
        one_time_prekey: otpk.map(|r| OneTimePreKeyOut {
            key_id: r.key_id,
            public_key: b64_encode(&r.public_key),
        }),
    })
}

/// GET /v1/prekeys/{username}
pub async fn fetch_by_username(
    State(state): State<AppState>,
    Path(username): Path<String>,
) -> Result<Json<BundleResp>, AppError> {
    let uname = username.to_lowercase();
    let row = sqlx::query!("SELECT identity_key FROM accounts WHERE username = $1", &uname)
        .fetch_optional(&state.pg)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(build_bundle(&state, &row.identity_key).await?))
}

/// GET /v1/prekeys/key/{identity_key_b64}
pub async fn fetch_by_key(
    State(state): State<AppState>,
    Path(key_b64): Path<String>,
) -> Result<Json<BundleResp>, AppError> {
    let identity = b64_decode(&key_b64).ok_or(AppError::BadRequest)?;
    if identity.len() != 33 {
        return Err(AppError::BadRequest);
    }
    Ok(Json(build_bundle(&state, &identity).await?))
}

#[derive(Deserialize)]
pub struct ReplenishReq {
    /// Optional neuer Signed PreKey (Rotation).
    pub signed_prekey: Option<SignedPreKeyJson>,
    /// Zusätzliche One-Time-PreKeys.
    #[serde(default)]
    pub one_time_prekeys: Vec<OneTimePreKeyJson>,
}

/// POST /v1/prekeys  (auth) — Rotation des Signed PreKey und/oder Nachfüllen.
pub async fn replenish(
    State(state): State<AppState>,
    AuthedIdentity(identity): AuthedIdentity,
    Json(req): Json<ReplenishReq>,
) -> Result<Json<serde_json::Value>, AppError> {
    let mut tx = state.pg.begin().await?;

    if let Some(spk) = req.signed_prekey {
        let pk = b64_decode(&spk.public_key).ok_or(AppError::BadRequest)?;
        let sig = b64_decode(&spk.signature).ok_or(AppError::BadRequest)?;
        if !verify_signature(&identity, &pk, &sig) {
            return Err(AppError::BadRequest);
        }
        sqlx::query!(
            "UPDATE signed_prekeys
               SET key_id = $2, public_key = $3, signature = $4, updated_at = now()
             WHERE identity_key = $1",
            &identity,
            spk.key_id,
            &pk,
            &sig
        )
        .execute(&mut *tx)
        .await?;
    }

    for otpk in &req.one_time_prekeys {
        let pk = b64_decode(&otpk.public_key).ok_or(AppError::BadRequest)?;
        sqlx::query!(
            "INSERT INTO one_time_prekeys (identity_key, key_id, public_key)
             VALUES ($1, $2, $3)
             ON CONFLICT (identity_key, key_id) DO NOTHING",
            &identity,
            otpk.key_id,
            &pk
        )
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}
